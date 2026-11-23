"""
Worker de transcription AI Clip Studio (Faster-Whisper).

Protocole : une ligne JSON par message.
  stdin  (Node -> worker) : {"cmd": "init", ...} puis {"cmd": "transcribe", ...}*, {"cmd": "shutdown"}
  stdout (worker -> Node) : ready | segment | progress | device_fallback | block_done | error
  stderr                  : journal lisible (jamais de données de protocole)

Le worker ne lit QUE le fichier WAV dérivé qu'on lui indique (16 kHz mono, aligné sur le
temps source) et uniquement la tranche demandée. Les temps renvoyés sont en millisecondes
du temps SOURCE : décalage de la tranche ajouté, arrondis à l'entier.
Aucune donnée n'est envoyée sur le réseau (seul le modèle est téléchargé au premier usage).
"""

from __future__ import annotations

import json
import sys
import time
import traceback
import wave
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

SAMPLE_RATE = 16_000

# Messages d'erreur caractéristiques d'un problème CUDA / cuDNN / cuBLAS.
CUDA_ERROR_MARKERS = (
    "cuda",
    "cudnn",
    "cublas",
    "cudart",
    "nvrtc",
    "no kernel image",
    "gpu",
)


def is_cuda_error(err: BaseException) -> bool:
    text = f"{type(err).__name__}: {err}".lower()
    return any(marker in text for marker in CUDA_ERROR_MARKERS)


def log(message: str) -> None:
    print(f"[worker] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# Lecture d'une tranche de WAV                                                #
# --------------------------------------------------------------------------- #


def read_wav_slice(path: str, start_ms: int, end_ms: int):
    """Tranche [start_ms, end_ms[ d'un WAV PCM 16 bits mono 16 kHz, en float32 [-1, 1]."""
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getframerate() != SAMPLE_RATE or w.getsampwidth() != 2:
            raise ValueError(
                f"WAV inattendu ({w.getnchannels()} canaux, {w.getframerate()} Hz, "
                f"{8 * w.getsampwidth()} bits) : 16 kHz mono 16 bits attendu"
            )
        total = w.getnframes()
        first = min(total, max(0, start_ms * SAMPLE_RATE // 1000))
        last = min(total, max(first, end_ms * SAMPLE_RATE // 1000))
        w.setpos(first)
        raw = w.readframes(last - first)
    return np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0


# --------------------------------------------------------------------------- #
# Modèle                                                                      #
# --------------------------------------------------------------------------- #


@dataclass
class InitOptions:
    model: str
    device: str  # auto | cuda | cpu
    compute_type: str  # auto | float16 | int8_float16 | int8 | ...
    cpu_fallback: bool
    cpu_compute_type: str
    download_root: Optional[str]
    beam_size: int
    batch_size: int
    word_timestamps: bool
    vad: dict
    hotwords: Optional[str]

    @staticmethod
    def from_cmd(cmd: dict) -> "InitOptions":
        return InitOptions(
            model=str(cmd["model"]),
            device=str(cmd["device"]),
            compute_type=str(cmd["computeType"]),
            cpu_fallback=bool(cmd["cpuFallback"]),
            cpu_compute_type=str(cmd["cpuComputeType"]),
            download_root=cmd.get("downloadRoot"),
            beam_size=int(cmd["beamSize"]),
            batch_size=int(cmd["batchSize"]),
            word_timestamps=bool(cmd["wordTimestamps"]),
            vad=dict(cmd["vad"]),
            hotwords=cmd.get("hotwords"),
        )


def resolve_compute_type(device: str, requested: str) -> str:
    if requested != "auto":
        return requested
    return "float16" if device == "cuda" else "int8"


def default_model_factory(opts: InitOptions, device: str, compute_type: str):
    from faster_whisper import BatchedInferencePipeline, WhisperModel

    model = WhisperModel(
        opts.model,
        device=device,
        compute_type=compute_type,
        download_root=opts.download_root or None,
    )
    if opts.batch_size > 0:
        return BatchedInferencePipeline(model=model)
    return model


def cuda_device_count() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:  # noqa: BLE001 - absence de CUDA ou de ctranslate2
        return 0


def engine_versions() -> tuple[str, str]:
    try:
        import ctranslate2
        import faster_whisper

        return str(faster_whisper.__version__), str(ctranslate2.__version__)
    except Exception:  # noqa: BLE001
        return "unknown", "unknown"


# --------------------------------------------------------------------------- #
# Worker                                                                      #
# --------------------------------------------------------------------------- #


@dataclass
class Worker:
    emit: Callable[[dict], None]
    model_factory: Callable[[InitOptions, str, str], Any] = default_model_factory
    cuda_count: Callable[[], int] = cuda_device_count
    versions: Callable[[], tuple[str, str]] = engine_versions
    opts: Optional[InitOptions] = None
    model: Any = None
    device: str = "cpu"
    compute_type: str = "int8"
    stopped: bool = False

    # -- chargement ---------------------------------------------------------- #

    def _load(self, device: str, compute_type: str) -> None:
        assert self.opts is not None
        log(f"chargement du modèle {self.opts.model} sur {device} ({compute_type})")
        self.model = self.model_factory(self.opts, device, compute_type)
        self.device = device
        self.compute_type = compute_type

    def _fallback_to_cpu(self, request_id: Optional[int], err: BaseException) -> None:
        assert self.opts is not None
        detail = f"{type(err).__name__}: {err}"
        log(f"échec CUDA : {detail}")
        if not self.opts.cpu_fallback:
            raise GpuUnavailable(detail) from err
        cpu_ct = resolve_compute_type("cpu", self.opts.cpu_compute_type)
        self.emit(
            {
                "type": "device_fallback",
                "requestId": request_id,
                "from": "cuda",
                "to": "cpu",
                "computeType": cpu_ct,
                "error": detail[:2000],
            }
        )
        self._load("cpu", cpu_ct)

    def init(self, cmd: dict) -> None:
        self.opts = InitOptions.from_cmd(cmd)
        started = time.perf_counter()
        cuda_count = self.cuda_count()
        wanted = self.opts.device
        if wanted == "auto":
            wanted = "cuda" if cuda_count > 0 else "cpu"
            if wanted == "cpu":
                log("aucun GPU CUDA détecté : CPU")
        fallback = None
        try:
            self._load(wanted, resolve_compute_type(wanted, self.opts.compute_type))
        except Exception as err:  # noqa: BLE001
            if wanted != "cuda" or not is_cuda_error(err):
                raise
            self._fallback_to_cpu(None, err)
            fallback = {"from": "cuda", "error": f"{type(err).__name__}: {err}"[:2000]}
        engine_version, ct2_version = self.versions()
        self.emit(
            {
                "type": "ready",
                "engine": "faster-whisper",
                "engineVersion": engine_version,
                "ctranslate2Version": ct2_version,
                "model": self.opts.model,
                "device": self.device,
                "computeType": self.compute_type,
                "cudaDeviceCount": cuda_count,
                "loadMs": int((time.perf_counter() - started) * 1000),
                "fallback": fallback,
            }
        )

    # -- transcription ------------------------------------------------------- #

    def _transcribe_kwargs(self, language: Optional[str]) -> dict:
        assert self.opts is not None
        vad = self.opts.vad
        kwargs: dict[str, Any] = {
            "language": language,
            "beam_size": self.opts.beam_size,
            "word_timestamps": self.opts.word_timestamps,
            "vad_filter": bool(vad.get("enabled", True)),
        }
        if kwargs["vad_filter"]:
            kwargs["vad_parameters"] = {
                "threshold": float(vad["threshold"]),
                "min_silence_duration_ms": int(vad["minSilenceDurationMs"]),
                "min_speech_duration_ms": int(vad["minSpeechDurationMs"]),
                "speech_pad_ms": int(vad["speechPadMs"]),
            }
        if self.opts.hotwords:
            kwargs["hotwords"] = self.opts.hotwords
        if self.opts.batch_size > 0:
            kwargs["batch_size"] = self.opts.batch_size
        return kwargs

    def _run_block(self, cmd: dict) -> None:
        request_id = int(cmd["requestId"])
        start_ms = int(cmd["startMs"])
        end_ms = int(cmd["endMs"])
        language = cmd.get("language")
        audio = read_wav_slice(str(cmd["wavPath"]), start_ms, end_ms)
        audio_ms = int(len(audio) * 1000 / SAMPLE_RATE)
        started = time.perf_counter()

        def to_source_ms(seconds: float) -> int:
            return min(end_ms, max(start_ms, start_ms + int(round(float(seconds) * 1000))))

        segments: Iterable[Any]
        segments, info = self.model.transcribe(audio, **self._transcribe_kwargs(language))
        out: list[dict] = []
        for seg in segments:  # générateur : le décodage se fait au fil de l'itération
            words = []
            for w in getattr(seg, "words", None) or []:
                words.append(
                    {
                        "word": str(w.word),
                        "startMs": to_source_ms(w.start),
                        "endMs": to_source_ms(w.end),
                        "probability": min(1.0, max(0.0, float(w.probability))),
                    }
                )
            out.append(
                {
                    "type": "segment",
                    "requestId": request_id,
                    "startMs": to_source_ms(seg.start),
                    "endMs": to_source_ms(seg.end),
                    "text": str(seg.text).strip(),
                    "avgLogprob": float(seg.avg_logprob),
                    "noSpeechProb": min(1.0, max(0.0, float(seg.no_speech_prob))),
                    "compressionRatio": max(0.0, float(seg.compression_ratio)),
                    "words": words,
                }
            )
            self.emit({"type": "progress", "requestId": request_id, "processedMs": to_source_ms(seg.end)})
        # Les segments ne sont émis qu'une fois le bloc entièrement décodé : en cas d'échec
        # CUDA en cours de bloc, le bloc est rejoué sur CPU sans segment partiel.
        for message in out:
            self.emit(message)
        self.emit(
            {
                "type": "block_done",
                "requestId": request_id,
                "language": getattr(info, "language", None),
                "languageProbability": (
                    None
                    if getattr(info, "language_probability", None) is None
                    else min(1.0, max(0.0, float(info.language_probability)))
                ),
                "device": self.device,
                "computeType": self.compute_type,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "audioMs": audio_ms,
            }
        )

    def transcribe(self, cmd: dict) -> None:
        if self.model is None:
            raise ProtocolError("init requis avant transcribe")
        try:
            self._run_block(cmd)
        except GpuUnavailable:
            raise
        except Exception as err:  # noqa: BLE001
            if self.device != "cuda" or not is_cuda_error(err):
                raise
            # Erreur CUDA à l'inférence (ex. cuDNN introuvable) : repli puis rejeu du bloc.
            self._fallback_to_cpu(int(cmd["requestId"]), err)
            self._run_block(cmd)

    # -- boucle -------------------------------------------------------------- #

    def handle(self, cmd: dict) -> None:
        name = cmd.get("cmd")
        request_id = cmd.get("requestId")
        try:
            if name == "init":
                self.init(cmd)
            elif name == "transcribe":
                self.transcribe(cmd)
            elif name == "shutdown":
                self.stopped = True
            else:
                raise ProtocolError(f"commande inconnue : {name!r}")
        except GpuUnavailable as err:
            self.emit({"type": "error", "requestId": request_id, "code": "GPU_UNAVAILABLE", "message": str(err)})
        except ProtocolError as err:
            self.emit({"type": "error", "requestId": request_id, "code": "PROTOCOL", "message": str(err)})
        except Exception as err:  # noqa: BLE001
            log(traceback.format_exc())
            self.emit(
                {
                    "type": "error",
                    "requestId": request_id,
                    "code": "FAILED",
                    "message": f"{type(err).__name__}: {err}"[:2000],
                }
            )


class GpuUnavailable(Exception):
    """CUDA a échoué et le repli CPU n'est pas autorisé."""


class ProtocolError(Exception):
    """Commande invalide."""


def stdout_emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    worker = Worker(
        emit=stdout_emit,
        model_factory=default_model_factory,
        cuda_count=cuda_device_count,
        versions=engine_versions,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as err:
            stdout_emit({"type": "error", "requestId": None, "code": "PROTOCOL", "message": f"JSON invalide : {err}"})
            continue
        worker.handle(cmd)
        if worker.stopped:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
