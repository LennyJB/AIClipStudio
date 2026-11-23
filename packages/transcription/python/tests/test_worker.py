"""Tests du worker avec un FAUX modèle : protocole, temps source, repli CUDA → CPU."""

import io
import json
import struct
import wave
from types import SimpleNamespace

import pytest

import worker as w


def make_wav(path, seconds, value_fn=lambda i: 0):
    n = int(seconds * w.SAMPLE_RATE)
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(w.SAMPLE_RATE)
        f.writeframes(b"".join(struct.pack("<h", value_fn(i)) for i in range(n)))
    return str(path)


INIT = {
    "cmd": "init",
    "model": "fake",
    "device": "auto",
    "computeType": "auto",
    "cpuFallback": True,
    "cpuComputeType": "auto",
    "downloadRoot": None,
    "beamSize": 5,
    "batchSize": 0,
    "wordTimestamps": True,
    "vad": {"enabled": True, "threshold": 0.5, "minSilenceDurationMs": 500, "minSpeechDurationMs": 250, "speechPadMs": 200},
    "hotwords": None,
}


class FakeModel:
    """Renvoie des segments relatifs au début de l'audio fourni (comme Faster-Whisper)."""

    def __init__(self, device, segments=None, fail_on_transcribe=None, language="fr"):
        self.device = device
        self.segments = segments or [(0.5, 1.75, " Salut à tous", [(0.5, 0.9, " Salut", 0.98), (1.0, 1.75, " à tous", 0.91)])]
        self.fail_on_transcribe = fail_on_transcribe
        self.language = language
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append({"samples": len(audio), **kwargs})
        if self.fail_on_transcribe:
            raise self.fail_on_transcribe

        def gen():
            for start, end, text, words in self.segments:
                yield SimpleNamespace(
                    start=start,
                    end=end,
                    text=text,
                    avg_logprob=-0.21,
                    no_speech_prob=0.03,
                    compression_ratio=1.4,
                    words=[SimpleNamespace(start=a, end=b, word=t, probability=p) for a, b, t, p in words],
                )

        info = SimpleNamespace(language=kwargs.get("language") or self.language, language_probability=0.97)
        return gen(), info


def make_worker(cuda=1, factory=None):
    out = []
    worker = w.Worker(
        emit=out.append,
        model_factory=factory or (lambda opts, device, ct: FakeModel(device)),
        cuda_count=lambda: cuda,
        versions=lambda: ("1.2.1", "4.9.1"),
    )
    return worker, out


def test_init_auto_choisit_cuda_si_disponible():
    worker, out = make_worker(cuda=1)
    worker.handle(INIT)
    assert out[0]["type"] == "ready"
    assert out[0]["device"] == "cuda"
    assert out[0]["computeType"] == "float16"
    assert out[0]["fallback"] is None


def test_init_auto_sans_gpu_utilise_le_cpu_en_int8():
    worker, out = make_worker(cuda=0)
    worker.handle(INIT)
    assert (out[0]["device"], out[0]["computeType"]) == ("cpu", "int8")


def test_temps_en_millisecondes_source_avec_decalage_de_la_tranche(tmp_path):
    wav = make_wav(tmp_path / "a.wav", 5)
    worker, out = make_worker()
    worker.handle(INIT)
    worker.handle({"cmd": "transcribe", "requestId": 1, "wavPath": wav, "startMs": 2000, "endMs": 4000, "language": None})
    seg = next(m for m in out if m["type"] == "segment")
    assert (seg["startMs"], seg["endMs"]) == (2500, 3750)
    assert [(x["startMs"], x["endMs"]) for x in seg["words"]] == [(2500, 2900), (3000, 3750)]
    assert seg["text"] == "Salut à tous"
    assert seg["avgLogprob"] == pytest.approx(-0.21)
    done = out[-1]
    assert done["type"] == "block_done"
    assert done["language"] == "fr"
    assert done["audioMs"] == 2000
    # 2 s de 16 kHz transmises au modèle, langue automatique, VAD activée.
    call = worker.model.calls[0]
    assert call["samples"] == 32000
    assert call["language"] is None
    assert call["vad_filter"] is True
    assert call["vad_parameters"]["min_silence_duration_ms"] == 500
    assert call["word_timestamps"] is True


def test_langue_imposee_transmise(tmp_path):
    wav = make_wav(tmp_path / "a.wav", 1)
    worker, out = make_worker()
    worker.handle(INIT)
    worker.handle({"cmd": "transcribe", "requestId": 1, "wavPath": wav, "startMs": 0, "endMs": 1000, "language": "en"})
    assert worker.model.calls[0]["language"] == "en"
    assert out[-1]["language"] == "en"


def test_temps_bornes_a_la_tranche(tmp_path):
    wav = make_wav(tmp_path / "a.wav", 3)
    worker, out = make_worker(
        factory=lambda o, d, c: FakeModel(d, segments=[(-0.2, 9.0, "déborde", [])])
    )
    worker.handle(INIT)
    worker.handle({"cmd": "transcribe", "requestId": 1, "wavPath": wav, "startMs": 1000, "endMs": 2000, "language": None})
    seg = next(m for m in out if m["type"] == "segment")
    assert (seg["startMs"], seg["endMs"]) == (1000, 2000)


def test_lecture_de_tranche_exacte(tmp_path):
    wav = make_wav(tmp_path / "a.wav", 2, value_fn=lambda i: 1000 if i >= 16000 else 0)
    audio = w.read_wav_slice(wav, 900, 1100)
    assert len(audio) == 3200
    assert float(audio[:1600].max()) == 0.0
    assert float(audio[1600:].min()) == pytest.approx(1000 / 32768)


def test_refuse_un_wav_non_16khz_mono(tmp_path):
    path = tmp_path / "s.wav"
    with wave.open(str(path), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(48000)
        f.writeframes(b"\0" * 400)
    with pytest.raises(ValueError):
        w.read_wav_slice(str(path), 0, 10)


def test_echec_cuda_au_chargement_bascule_sur_cpu_et_le_dit():
    def factory(opts, device, ct):
        if device == "cuda":
            raise RuntimeError("CUDA failed with error no CUDA-capable device is detected")
        return FakeModel(device)

    worker, out = make_worker(factory=factory)
    worker.handle(INIT)
    fb = out[0]
    assert fb["type"] == "device_fallback"
    assert (fb["from"], fb["to"], fb["computeType"]) == ("cuda", "cpu", "int8")
    assert "no CUDA-capable device" in fb["error"]
    ready = out[1]
    assert ready["device"] == "cpu"
    assert ready["fallback"]["from"] == "cuda"


def test_echec_cudnn_a_l_inference_rejoue_le_bloc_sur_cpu(tmp_path):
    wav = make_wav(tmp_path / "a.wav", 2)

    def factory(opts, device, ct):
        if device == "cuda":
            return FakeModel(device, fail_on_transcribe=RuntimeError("Could not load library cudnn_ops64_9.dll"))
        return FakeModel(device)

    worker, out = make_worker(factory=factory)
    worker.handle(INIT)
    worker.handle({"cmd": "transcribe", "requestId": 7, "wavPath": wav, "startMs": 0, "endMs": 2000, "language": None})
    types = [m["type"] for m in out]
    assert types[0] == "ready"
    assert "device_fallback" in types
    fb = next(m for m in out if m["type"] == "device_fallback")
    assert fb["requestId"] == 7 and "cudnn" in fb["error"]
    done = out[-1]
    assert done["type"] == "block_done" and done["device"] == "cpu"
    # Pas de segment partiel émis par la tentative CUDA : un seul segment au total.
    assert types.count("segment") == 1


def test_sans_repli_autorise_l_echec_cuda_est_une_erreur_explicite():
    def factory(opts, device, ct):
        raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")

    worker, out = make_worker(factory=factory)
    worker.handle({**INIT, "device": "cuda", "cpuFallback": False})
    assert out[-1]["type"] == "error"
    assert out[-1]["code"] == "GPU_UNAVAILABLE"
    assert "cublas" in out[-1]["message"]
    assert not any(m["type"] == "ready" for m in out)


def test_une_erreur_non_cuda_n_entraine_pas_de_repli(tmp_path):
    def factory(opts, device, ct):
        return FakeModel(device, fail_on_transcribe=ValueError("audio corrompu"))

    wav = make_wav(tmp_path / "a.wav", 1)
    worker, out = make_worker(factory=factory)
    worker.handle(INIT)
    worker.handle({"cmd": "transcribe", "requestId": 1, "wavPath": wav, "startMs": 0, "endMs": 1000, "language": None})
    assert out[-1]["code"] == "FAILED"
    assert not any(m["type"] == "device_fallback" for m in out)


def test_protocole_commande_inconnue_et_transcribe_avant_init():
    worker, out = make_worker()
    worker.handle({"cmd": "danse"})
    worker.handle({"cmd": "transcribe", "requestId": 1})
    assert [m["code"] for m in out] == ["PROTOCOL", "PROTOCOL"]


def test_boucle_principale_json_par_ligne(monkeypatch, tmp_path):
    wav = make_wav(tmp_path / "a.wav", 1)
    lines = [
        json.dumps({**INIT, "device": "cpu"}),
        "pas du json",
        json.dumps({"cmd": "transcribe", "requestId": 1, "wavPath": wav, "startMs": 0, "endMs": 1000, "language": "fr"}),
        json.dumps({"cmd": "shutdown"}),
        json.dumps({"cmd": "init"}),  # ignorée : arrêt demandé
    ]
    monkeypatch.setattr(w.sys, "stdin", io.StringIO("\n".join(lines) + "\n"))
    stdout = io.StringIO()
    monkeypatch.setattr(w.sys, "stdout", stdout)
    monkeypatch.setattr(w, "default_model_factory", lambda o, d, c: FakeModel(d))
    monkeypatch.setattr(w, "cuda_device_count", lambda: 0)
    assert w.main() == 0
    messages = [json.loads(l) for l in stdout.getvalue().splitlines()]
    assert [m["type"] for m in messages] == ["ready", "error", "progress", "segment", "block_done"]
