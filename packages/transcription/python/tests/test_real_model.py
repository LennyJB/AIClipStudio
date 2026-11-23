"""
Test de bout en bout avec un VRAI modèle Faster-Whisper (tiny, CPU).
Exécuté uniquement si ACS_WHISPER_REAL=1 (CI) : nécessite le téléchargement du modèle
depuis Hugging Face et FFmpeg compilé avec flite (synthèse vocale).
Aucun GPU n'est utilisé ici : ce test ne valide PAS la transcription GPU.
"""

import os
import shutil
import subprocess

import pytest

import worker as w

REAL = os.environ.get("ACS_WHISPER_REAL") == "1"
pytestmark = pytest.mark.skipif(not REAL, reason="ACS_WHISPER_REAL=1 requis (modèle réel, réseau)")

SPEECH_AT_MS = 3000
TEXT = "hello world, this is a test of the transcription system"


@pytest.fixture(scope="module")
def speech_wav(tmp_path_factory):
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg, "FFmpeg requis"
    path = tmp_path_factory.mktemp("speech") / "speech.wav"
    # 3 s de silence, la phrase de synthèse, puis 2 s de silence ; 16 kHz mono 16 bits.
    subprocess.run(
        [
            ffmpeg, "-v", "error", "-y",
            "-f", "lavfi", "-i", f"flite=text='{TEXT}':voice=slt",
            "-af", f"adelay={SPEECH_AT_MS}|{SPEECH_AT_MS},apad=pad_dur=2,aresample=16000",
            "-ac", "1", "-c:a", "pcm_s16le", str(path),
        ],
        check=True,
    )
    return str(path)


def run(wav, start_ms, end_ms, language=None):
    out = []
    worker = w.Worker(emit=out.append, model_factory=w.default_model_factory,
                      cuda_count=lambda: 0, versions=w.engine_versions)
    worker.handle({
        "cmd": "init", "model": "tiny", "device": "cpu", "computeType": "int8",
        "cpuFallback": True, "cpuComputeType": "int8",
        "downloadRoot": os.environ.get("ACS_WHISPER_MODEL_DIR"),
        "beamSize": 1, "batchSize": 0, "wordTimestamps": True,
        "vad": {"enabled": True, "threshold": 0.5, "minSilenceDurationMs": 500,
                "minSpeechDurationMs": 250, "speechPadMs": 200},
        "hotwords": None,
    })
    assert out[0]["type"] == "ready", out
    assert out[0]["device"] == "cpu"
    worker.handle({"cmd": "transcribe", "requestId": 1, "wavPath": wav,
                   "startMs": start_ms, "endMs": end_ms, "language": language})
    return out


def test_transcription_reelle_texte_langue_et_horodatage(speech_wav):
    out = run(speech_wav, 0, 20_000)
    segments = [m for m in out if m["type"] == "segment"]
    done = out[-1]
    assert done["type"] == "block_done", out
    assert done["language"] == "en"
    text = " ".join(s["text"] for s in segments).lower()
    assert "test" in text or "hello" in text, text
    first = segments[0]
    # La parole commence à 3 s : tolérance large (modèle tiny, précision de Whisper).
    assert 2000 <= first["startMs"] <= 4000, first
    assert first["words"], "mots horodatés attendus"
    for word in first["words"]:
        assert first["startMs"] - 1000 <= word["startMs"] <= word["endMs"] <= first["endMs"] + 1000
        assert 0.0 <= word["probability"] <= 1.0


def test_decalage_d_une_tranche_conserve_le_temps_source(speech_wav):
    whole = [m for m in run(speech_wav, 0, 20_000) if m["type"] == "segment"]
    sliced = [m for m in run(speech_wav, 1500, 20_000) if m["type"] == "segment"]
    assert whole and sliced
    # Même parole, lue à partir de 1,5 s : les temps SOURCE doivent rester proches.
    assert abs(whole[0]["startMs"] - sliced[0]["startMs"]) <= 600
