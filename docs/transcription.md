# Transcription (étape 3) — Faster-Whisper

Transcription **locale** des pistes de voix d'un enregistrement OBS. Seul le modèle est téléchargé
(une fois, depuis Hugging Face) : **aucun audio ne quitte la machine**.

## 1. Installation

### Python et Faster-Whisper

Voir le README (venv dans `.venv/`). Puis :

```bash
.venv\Scripts\python -m pip install -r packages/transcription/python/requirements.txt
```

### GPU NVIDIA (facultatif)

CTranslate2 (moteur de Faster-Whisper) exige **cuBLAS (CUDA 12) et cuDNN 9**. Le plus simple est
de les installer par pip, dans le même venv :

```bash
.venv\Scripts\python -m pip install -r packages/transcription/python/requirements-gpu.txt
```

Sous Windows, ces DLL sont installées dans `site-packages\nvidia\*\bin`, hors du `PATH` : le
worker les déclare lui-même au démarrage.

### Vérifier le GPU (sur votre machine)

```bash
npm run doctor -- --gpu
```

Ce test charge un modèle (`tiny` par défaut, `--gpu-model` pour un autre) **sur CUDA sans repli
CPU** et effectue une vraie inférence : c'est à ce moment que cuBLAS/cuDNN sont chargés. Détecter
le GPU ne suffit pas.

> **RTX 50xx (Blackwell)** : la compatibilité de CTranslate2 4.9.1 n'a pas pu être vérifiée
> (aucun GPU dans l'environnement de développement ni dans la CI). C'est ce test qui tranche.

## 2. Utilisation

```bash
npm run transcribe -- "D:\Enregistrements\stream.mkv" --game valorant
```

```bash
npm run transcribe -- <id> --model large-v3
```

```bash
npm run transcribe -- <id> --compare
```

- La première commande importe le fichier si besoin puis transcrit avec le modèle par défaut.
- `--model` lance une transcription avec un autre modèle ; les deux coexistent.
- `--compare` affiche le tableau comparatif sans transcrire.
- `--force` retranscrit même si une transcription identique existe.
- `Ctrl+C` interrompt proprement ; **relancer la même commande reprend au dernier bloc enregistré**.

Interface : `npm run dev`, section « Enregistrements », puis « Transcrire ».

API : `POST /api/recordings/:id/transcriptions` (`{ model?, language?, force? }`),
`GET /api/recordings/:id/transcriptions` (états, métriques, comparaisons),
`GET /api/recordings/:id/transcript?model=…&audioIndex=1,2&fromMs=&toMs=`.

## 3. Configuration (`.env`)

| Variable                        | Défaut                               | Rôle                                                                 |
| ------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `WHISPER_MODEL`                 | `large-v3-turbo`                     | Modèle par défaut                                                    |
| `WHISPER_MODEL_CHOICES`         | `large-v3-turbo,large-v3`            | Modèles proposés (interface, `--model`)                              |
| `WHISPER_DEVICE`                | `auto`                               | `auto` (CUDA si disponible), `cuda`, `cpu`                           |
| `WHISPER_CPU_FALLBACK`          | `true`                               | Repli CPU si CUDA échoue                                             |
| `WHISPER_COMPUTE_TYPE`          | `auto`                               | `auto` = `float16` sur GPU, `int8` sur CPU                           |
| `WHISPER_CPU_COMPUTE_TYPE`      | `int8`                               | Calcul en cas de repli CPU                                           |
| `WHISPER_LANGUAGE`              | `auto`                               | Détection, ou langue imposée (`fr`, `en`…)                           |
| `WHISPER_BEAM_SIZE`             | `5`                                  | Recherche en faisceau (qualité ↔ vitesse)                            |
| `WHISPER_BATCH_SIZE`            | `0`                                  | `0` séquentiel ; `> 0` par lots (plus rapide sur GPU, plus de VRAM)  |
| `WHISPER_WORD_TIMESTAMPS`       | `true`                               | Mots horodatés (sous-titres, coupes précises)                        |
| `WHISPER_VAD`, `WHISPER_VAD_*`  | activée, 0,5, 500 ms, 250 ms, 400 ms | Détection de parole : seuil, silence minimal, parole minimale, marge |
| `WHISPER_CHUNK_SEC`             | `1200`                               | Zone centrale d'un bloc (20 min)                                     |
| `WHISPER_CHUNK_OVERLAP_SEC`     | `30`                                 | Chevauchement avant **et** après                                     |
| `WHISPER_BOUNDARY_TOLERANCE_MS` | `1000`                               | Tolérance d'attribution aux frontières                               |
| `WHISPER_MODEL_DIR`             | `./storage/models`                   | Modèles téléchargés (jamais nettoyés)                                |

Vocabulaire du jeu : **désactivé par défaut**, activable par profil
(`profiles/games/<jeu>.json` → `"transcription": { "useVocabulary": true, "extraTerms": [...] }`).
Il est transmis à Whisper comme `hotwords`. Il peut aider (« spike », « clutch ») comme biaiser
la transcription : à mesurer à l'étape 6.

Tous les paramètres qui influencent le résultat entrent dans la **clé de cache** : changer un
réglage produit une nouvelle transcription, ne réutilise jamais l'ancienne.

## 4. Compromis précision / VRAM / temps

**Ordres de grandeur issus de la documentation de Faster-Whisper, NON mesurés sur votre machine.**
Mesurez avec `npm run transcribe -- <id> --compare` (durée, facteur temps réel, périphérique réel).

| Modèle             | Précision                                          | VRAM (float16) | Vitesse relative           |
| ------------------ | -------------------------------------------------- | -------------- | -------------------------- |
| `large-v3`         | Référence                                          | ≈ 4 à 5 Go     | 1×                         |
| `large-v3-turbo`   | Proche, un peu moins robuste sur l'audio difficile | ≈ 2 à 3 Go     | Plusieurs fois plus rapide |
| `medium` / `small` | Nettement inférieure en français conversationnel   | ≈ 1 à 2 Go     | Plus rapide                |

| Calcul                        | Effet                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `float16` (GPU)               | Défaut GPU ; meilleure qualité                                                                  |
| `int8_float16` (GPU)          | ≈ −30 à −40 % de VRAM, qualité très proche                                                      |
| `int8` (CPU)                  | Seul choix raisonnable sur CPU ; un stream de 4 h peut prendre plusieurs heures avec `large-v3` |
| `WHISPER_BATCH_SIZE=8` à `16` | Nettement plus rapide sur GPU, VRAM supplémentaire                                              |
| `WHISPER_BEAM_SIZE=1`         | Plus rapide, un peu moins précis                                                                |

**Facteur temps réel** = durée d'audio traitée ÷ durée de traitement (hors chargement du modèle).
« ×20 » signifie 20 fois plus rapide que le temps réel. **Une comparaison n'a de sens que sur le
même périphérique** : l'interface et `--compare` le signalent sinon.

## 5. Fonctionnement

### Entrée

Le WAV 16 kHz mono dérivé (cache de l'étape 2), aligné sur le temps de l'original : les temps de
Whisper sont donc directement en **temps source** (`SourceMs`). Il est produit si absent, protégé
pendant la transcription et **jamais supprimé** à la fin. Le nettoyage du cache s'en charge selon
`CACHE_MAX_GB`, et il reste disponible pour une nouvelle transcription avec d'autres paramètres.

### Blocs, chevauchement et reprise

```
|<- 30 s ->|<---------- zone centrale : 20 min ---------->|<- 30 s ->|
readStart  coreStart = checkpoint                          coreEnd    readEnd
```

1. Whisper transcrit `[readStart, readEnd[` : les paroles aux frontières sont entendues en entier.
2. Un segment appartient au bloc dont la **zone centrale contient son point central** (milieu entre
   début et fin), avec une tolérance d'1 s : Whisper peut décaler un même passage d'un bloc à l'autre.
3. **Déduplication temporelle approximative** avec les segments déjà enregistrés : chevauchement
   ≥ 50 % et texte similaire, ou chevauchement ≥ 85 % avec un minimum de mots communs. Deux répliques
   différentes ne sont jamais confondues.
4. **Transaction unique** : segments + bloc + checkpoint (= fin de zone centrale). En cas d'échec,
   rien n'est écrit et le checkpoint ne bouge pas ; le checkpoint attendu est vérifié.
5. Reprise : même transcription, à partir du checkpoint.

Condition : le chevauchement doit dépasser la durée du plus long segment (Whisper : 30 s au plus).
Vérifié par des tests de propriétés (milliers de scénarios aléatoires : phrases aux frontières,
décalages, interruption puis reprise) : chaque phrase est enregistrée exactement une fois.

### Langue

Détectée sur le premier bloc **contenant de la parole**, puis imposée aux blocs suivants (y compris
après reprise). Ou imposée par `WHISPER_LANGUAGE`.

### GPU et repli CPU

| Situation                                       | Comportement                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `auto` sans GPU détecté                         | CPU, sans le présenter comme un repli                                                                          |
| Exception CUDA au chargement ou pendant un bloc | Erreur **journalisée en détail**, bascule CPU si `WHISPER_CPU_FALLBACK=true`, bloc rejoué sans segment partiel |
| Arrêt brutal du worker sur CUDA (DLL manquante) | Relance du worker sur CPU si autorisé                                                                          |
| Repli interdit                                  | Échec explicite `TRANSCRIPTION_GPU_UNAVAILABLE`                                                                |

Le périphérique **réellement utilisé** est enregistré **par bloc**. L'interface n'affiche « GPU »
que si tous les blocs ont tourné sur CUDA ; sinon « CPU (repli…) » ou « Mixte ».

### Indicateurs

- **Métriques brutes conservées** : `avg_logprob`, `no_speech_prob`, `compression_ratio` par segment,
  probabilité brute par mot, `language_probability`. Ce **ne sont pas des probabilités calibrées**.
- **`suspicion_score`** (0 à 1) : heuristique, avec ses raisons. Aucun segment n'est supprimé.

| Raison                | Règle                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| `no_speech`           | `no_speech_prob > 0,6` et `avg_logprob < −1`                                |
| `low_logprob`         | `avg_logprob < −1`                                                          |
| `repetition`          | `compression_ratio > 2,4`                                                   |
| `known_hallucination` | Phrase typique (ex. « Sous-titres réalisés par la communauté d'Amara.org ») |

## 6. Limites connues

- **Précision des horodatages** : stockés à la milliseconde, mais Whisper est précis à environ
  100 à 300 ms par segment, un peu mieux par mot.
- **Discord** : plusieurs coéquipiers sur une piste, sans distinction des voix.
- **Hallucinations** sur silence ou bruit de jeu : atténuées (VAD, signalement), pas éliminées.
- **Doublons partiels** : si Whisper découpe différemment un même passage d'un bloc à l'autre,
  un morceau de phrase peut rester en double. La déduplication porte sur les segments entiers.
- **GPU jamais testé** dans l'environnement de développement ni dans la CI.

## 7. Tests

| Niveau                                                                                                          | Où                                                              | Modèle                               |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------ |
| Découpage, frontières, reprise, déduplication (propriétés)                                                      | `packages/transcription/src/*.test.ts`                          | aucun                                |
| Worker : protocole, temps source, repli CUDA, DLL Windows                                                       | `python/tests/test_worker.py`                                   | faux modèle                          |
| Base : transaction, checkpoint, ordre chronologique                                                             | `services/api/src/transcriptions/repository.test.ts`            | —                                    |
| API de bout en bout : pistes multiples, reprise après plantage/annulation/arrêt, repli GPU, langue, comparaison | `services/api/src/transcriptions.integration.test.ts`           | faux worker (même protocole)         |
| Interface                                                                                                       | `apps/web/src/**/*.test.tsx`                                    | —                                    |
| **Vrai modèle** (`tiny`, CPU) : texte, langue, temps source                                                     | `python/tests/test_real_model.py`, `worker-client.real.test.ts` | CI uniquement (`ACS_WHISPER_REAL=1`) |

## 8. Premier test sur votre machine

1. `npm run doctor -- --gpu`
2. `npm run transcribe -- "<un stream court>" --game valorant`
3. `npm run transcribe -- <id> --model large-v3`
4. `npm run transcribe -- <id> --compare`

Envoyez-moi les sorties : périphérique réel, facteur temps réel, et quelques segments comparés à ce
que vous avez réellement dit.
