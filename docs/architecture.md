# Architecture et choix techniques

Ce document explique **pourquoi** le projet est organisé ainsi. Il complète le cahier des
charges (v1.2) et le plan technique du MVP (v1.0).

## 1. Principes

1. **Un monolithe modulaire, pas de microservices.** Un seul processus Node (API +
   orchestration) découpé en packages indépendants aux responsabilités claires.
2. **Les décisions de l'IA sont séparées de leur exécution.** Le package `editorial` produit
   des propositions validées (JSON strict) ; seul le code applicatif décide de ce qui est
   exécuté (FFmpeg, etc.), avec des paramètres contrôlés.
3. **Traitement local et différé.** Rien ne tourne pendant le stream ; FFmpeg et
   Faster-Whisper s'exécutent sur la machine du créateur.
4. **Jeu et créateur sont deux axes indépendants.** Le pipeline est commun ; les
   particularités vivent dans `profiles/games/*.json` et l'identité éditoriale dans
   `profiles/creator.json`.
5. **Les originaux sont en lecture seule.** Toute sortie va dans `storage/processing/` ou
   `storage/exports/`.

## 2. Correspondance avec le plan technique

| Brique du plan technique | Emplacement                                                       | Étape |
| ------------------------ | ----------------------------------------------------------------- | ----- |
| Importeur                | `services/api` (routes) + `packages/media`                        | 2     |
| Media Processor          | `packages/media`                                                  | 2     |
| Transcription Service    | `packages/transcription` (+ `python/`)                            | 3     |
| Candidate Detector       | `packages/editorial`                                              | 4     |
| Editorial Analyzer       | `packages/editorial`                                              | 4     |
| Validator                | schémas dans `packages/shared`, contrôles métier dans `editorial` | 4     |
| Review UI                | `apps/web`                                                        | 5     |

## 3. Écarts par rapport à l'arborescence indicative (et pourquoi)

| Changement                                                                         | Raison                                                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles/games/generic.json` ajouté                                               | Le cahier des charges demande un profil générique ; c'est aussi le profil de repli explicite.                                          |
| `packages/transcription/python/`                                                   | Le worker Faster-Whisper est en Python (pas de binding Node fiable). Il est rangé avec le package qui le pilote.                       |
| `storage/db/`                                                                      | Sépare la base SQLite des fichiers médias.                                                                                             |
| `scripts/doctor.ts`                                                                | Diagnostic reproductible, indispensable car la machine de production (Windows + RTX 5070) diffère de l'environnement de développement. |
| `docs/`                                                                            | Décisions d'architecture documentées.                                                                                                  |
| Tests unitaires **à côté du code** (`*.test.ts`), `tests/` réservé à l'intégration | Les tests restent proches de ce qu'ils vérifient ; `tests/` couvre ce qui traverse plusieurs packages.                                 |

## 4. Choix des outils

| Besoin                    | Choix                                                                                 | Justification                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo                  | **npm workspaces**                                                                    | Fourni avec Node, aucun outil supplémentaire à installer sous Windows.                                                                                                                                                                                                                                                                       |
| Langage                   | **TypeScript 6.0** (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | TypeScript 7 existe mais `typescript-eslint` ne le supporte pas encore (< 6.1).                                                                                                                                                                                                                                                              |
| Exécution TS              | **tsx**                                                                               | Exécute directement les sources ; les packages internes exportent leur `src/index.ts`, donc pas d'étape de build interne.                                                                                                                                                                                                                    |
| Serveur HTTP              | **Fastify 5**                                                                         | Logs JSON intégrés (pino), injection de requêtes pour les tests, performant.                                                                                                                                                                                                                                                                 |
| Validation                | **Zod 4**                                                                             | Un seul schéma = type TypeScript + validation à l'exécution (config, profils, réponses Claude).                                                                                                                                                                                                                                              |
| Base de données           | **better-sqlite3 12**                                                                 | SQLite synchrone et mature. À l'installation, un binaire précompilé est téléchargé (Windows, Linux, macOS), sans compilation. **La version 13 a été écartée** : malgré ses binaires embarqués, npm lance `node-gyp` qui, sous Windows, exige Visual Studio (constaté par la CI Windows). `node:sqlite` est encore expérimental dans Node 22. |
| Logs                      | **pino** (via Fastify) + pino-pretty en dev                                           | JSON structuré exploitable, lisible en développement.                                                                                                                                                                                                                                                                                        |
| Interface                 | **React 19 + Vite 8**                                                                 | Démarrage rapide, proxy `/api` en dev (pas de CORS à ouvrir).                                                                                                                                                                                                                                                                                |
| Tests                     | **Vitest 5**                                                                          | Compatible TS/ESM sans configuration, projets `unit` et `integration`.                                                                                                                                                                                                                                                                       |
| Qualité                   | **ESLint 10 + typescript-eslint + Prettier**                                          | Règles standard, imports de types cohérents.                                                                                                                                                                                                                                                                                                 |
| Variables d'environnement | `process.loadEnvFile` (natif Node)                                                    | Pas de dépendance `dotenv`.                                                                                                                                                                                                                                                                                                                  |

### Dépendances prévues aux étapes suivantes (non installées)

| Paquet                                          | Étape     | Utilité                                                       |
| ----------------------------------------------- | --------- | ------------------------------------------------------------- |
| `faster-whisper` (Python)                       | 3         | Transcription locale horodatée (déjà dans `requirements.txt`) |
| `@anthropic-ai/sdk` (installé : 1.6.0, épinglé) | 4b        | Appels Claude API (sorties structurées validées par Zod)      |
| `@fastify/multipart` ou import par chemin local | 2         | À décider : voir questions ouvertes                           |
| `remotion`, `@remotion/*`                       | Après MVP | Rendu des montages 9:16                                       |

## 5. Points de vigilance identifiés

- **RTX 5070 (Blackwell) + CTranslate2** : support CUDA à confirmer sur la machine réelle
  (`npm run doctor`). Repli possible en CPU `int8`.
- **VRAM 12 Go** : `large-v3` en `float16` tient en mémoire ; `int8_float16` en réserve.
- **Pistes audio OBS** : la séparation micro / audio du jeu / Discord dépend de la
  configuration OBS du créateur ; elle conditionne la qualité de la transcription et la
  distinction des intervenants.
- **Gros fichiers** : un enregistrement de plusieurs heures pèse plusieurs dizaines de Go ;
  l'import doit **référencer ou copier** sans charger le fichier en mémoire.
- **Coûts API** : ne jamais envoyer des heures de transcription brute ; découpage en fenêtres
  candidates et mesure des coûts dès l'étape 4.

## 6. Décisions de l'étape 2 (import et audio)

| Décision                                                                                                | Raison                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import par référence** (chemin + empreinte), pas de copie                                             | Fichiers de 20 à 40 Go ; demande du créateur. L'empreinte (sha256 de la taille + 1er/dernier Mo) détecte doublons et originaux modifiés en lisant 2 Mo seulement.                                                                                                                                                                |
| Les pistes **micro** et **Discord** sont transcrites séparément, la piste « tout » seulement en secours | Évite de transcrire deux fois les mêmes voix ; donne gratuitement la distinction créateur / coéquipiers.                                                                                                                                                                                                                         |
| `aresample=async=1:first_pts=0` à l'extraction                                                          | **Mesuré** : sans ce filtre, une piste démarrant à 2 s produit un WAV décalé de 2 s (timestamps faux). Avec, le silence initial est conservé et les trous comblés.                                                                                                                                                               |
| Durée inconnue acceptée, puis déduite de l'audio                                                        | **Mesuré** : un MKV non finalisé (OBS qui plante) n'expose aucune durée ; FFmpeg en extrait pourtant l'audio.                                                                                                                                                                                                                    |
| Extraction de toutes les pistes **en un seul passage** FFmpeg                                           | Le fichier source n'est lu qu'une fois (deux fois moins d'octets lus). Sur le disque rapide de développement, aucun gain de temps mesurable (≈ 5 s pour 10 min de vidéo 720p à 8 Mb/s, CPU limitant) ; le gain attendu concerne les disques lents et Google Drive, **non mesuré**. Sorties vérifiées identiques octet par octet. |
| Écriture dans `*.part` puis renommage                                                                   | Un traitement interrompu ne laisse jamais un fichier final incomplet ; la reprise se fonde sur les fichiers finaux présents.                                                                                                                                                                                                     |
| File de traitements en mémoire, persistée dans SQLite, **un traitement à la fois**                      | Pas de Redis/BullMQ pour un usage local mono-utilisateur ; FFmpeg et Whisper ne doivent pas se concurrencer. Au redémarrage, les traitements « en cours » deviennent « interrompus » (relançables).                                                                                                                              |
| Rôles des pistes : imposés > piste unique > nom OBS > `AUDIO_TRACK_ROLES`                               | L'ordre des pistes peut varier selon la configuration OBS ; les noms de pistes sont la source la plus fiable.                                                                                                                                                                                                                    |

## 7. Fondations complémentaires de l'étape 2 (implémentées le 23/11/2026)

> Implémentation : `packages/timeline`, `packages/media` (profils, plages, formes d'onde),
> `services/api/src/derivatives`, `jobs/runner.ts`, `storage/`. Migration : `docs/migration-2-fondations.md`.
> La section 6 reste valable, sauf : « un traitement à la fois » devient « un traitement à la
> fois **par file** » (§ 7.2), et le type `extract_audio` devient `extract_transcription_audio`.

**Mesures (environnement de développement, CPU 4 cœurs, sans GPU)** :

| Mesure                                                                                                   | Résultat                                                               |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Écart entre l'extraction d'une portion et celle de l'enregistrement complet (corrélation d'échantillons) | **3,6 ms** ; test automatique à ≤ 10 ms                                |
| Forme d'onde, 1 h d'audio 16 kHz                                                                         | 0,5 s ; 0,72 Mo                                                        |
| Pistes de montage d'une fenêtre de 2 min (fichier 720p de 10 min)                                        | 0,8 s                                                                  |
| Migration d'une base v1 réelle                                                                           | WAV repris sans réextraction ; seules les formes d'onde sont calculées |
| Tests de propriétés du modèle temporel                                                                   | 5 000 montages aléatoires par propriété, sans échec                    |

### 7.1 Fichiers dérivés et cache

Un **fichier dérivé** est tout fichier produit à partir d'un original : WAV pour Whisper, piste
audio de montage, forme d'onde, plus tard proxy vidéo ou vignette. Chaque dérivé est enregistré
dans la table `media_derivatives`, avec :

- son **usage** (`kind`) ;
- sa **piste** (`audio_index`, facultative) ;
- sa **plage source** (`src_start_ms`, `src_end_ms`, en `SourceMs`) : vide = tout l'enregistrement ;
- ses **paramètres** (fréquence, canaux, codec, résolution de forme d'onde) ;
- la **version du générateur** (incrémentée si le code de production change, ce qui invalide le cache) ;
- son **chemin relatif** au dossier de stockage (le dossier `storage/` peut être déplacé).

Profils de production :

| Usage (`kind`)        | Format                            | Portée                                                     | Taille indicative     |
| --------------------- | --------------------------------- | ---------------------------------------------------------- | --------------------- |
| `audio_transcription` | WAV PCM 16 kHz mono               | Tout l'enregistrement, pistes de voix                      | ≈ 115 Mo / h / piste  |
| `audio_stem`          | WAV PCM 48 kHz stéréo             | **Fenêtre d'un clip**, toutes les pistes utiles au montage | ≈ 11 Mo / min / piste |
| `waveform`            | Pics min/max 8 bits, 100 points/s | Tout l'enregistrement (piste de voix) ou fenêtre de clip   | ≈ 0,7 Mo / h / piste  |

Les deux profils audio utilisent le même filtre d'alignement sur le temps source. Les formes
d'onde sont calculées en Node, en lecture continue d'un WAV déjà produit (aucune relecture de
l'original). Format envisagé : celui d'`audiowaveform` (`.dat`), lisible par la bibliothèque
d'affichage peaks.js. **Compatibilité à vérifier à l'implémentation.**

**Clé de cache** : `sha256(empreinte de l'original, usage, piste, plage, paramètres canoniques,
version du générateur)`. Conséquences :

- **demande identique** → le dérivé existant est réutilisé, sans traitement ;
- **original modifié** → l'empreinte change, donc la clé aussi : l'ancien dérivé n'est plus
  jamais servi et devient éligible au nettoyage.

**Extraction à la demande** : un dérivé n'est produit que lorsqu'un usage le demande. La recherche
se fait dans cet ordre :

1. clé exacte ;
2. **dérivé englobant** : même piste, mêmes paramètres, plage qui contient la plage demandée.
   L'appelant reçoit le fichier et un décalage (temps média = temps source − début de la plage du dérivé) ;
3. traitement identique déjà en cours : on s'y rattache ;
4. sinon, création d'un traitement.

Pour augmenter les réutilisations, les fenêtres de clip sont **élargies d'une marge de 30 s puis
alignées sur une grille de 30 s**. Deux clips proches partagent ainsi souvent la même fenêtre.
Il n'y a pas d'assemblage de morceaux partiels : la complexité serait injustifiée.

Politique de choix des pistes :

- **Whisper** : micro + Discord, sinon le mix (inchangé) ;
- **montage** : micro + Discord + jeu si une piste `game` existe ; sinon le mix seul. Le mix n'est
  jamais superposé aux voix séparées.

### 7.2 File de traitements

- Chaque traitement porte un **type**, des **paramètres** (JSON validé par un schéma propre au
  type) et une **clé de cible** (`target_key`).
- **Unicité** : un seul traitement actif (`queued` ou `running`) par clé de cible, garanti par un
  index unique partiel en base. Deux demandes identiques se rattachent au même traitement.
- **Réutilisation** : avant de créer un traitement, on consulte le cache (§ 7.1). Si le résultat
  existe, l'API répond « prêt » sans rien créer.
- **Indépendance des clips** : deux clips d'un même enregistrement ont des plages différentes,
  donc des clés différentes. Aucun conflit.
- **Deux files d'exécution** (une tâche à la fois dans chacune) :
  - `heavy` : transcription, extraction complète, rendu final ;
  - `interactive` : pistes de clip, formes d'onde, proxies.

  Sans cette séparation, une transcription d'une heure bloquerait la préparation d'un clip dans l'éditeur.

- **Fichiers utilisés** : chaque traitement déclare ses fichiers d'entrée et de sortie
  (`job_files`) **avant** de démarrer. Le nettoyage ignore tout fichier déclaré par un traitement actif.
- Types de traitements : `extract_transcription_audio` (renommage de `extract_audio`),
  `extract_audio_stems`, `compute_waveform` ; plus tard `video_proxy` et `render`.

### 7.3 Gestion de l'espace disque

| Catégorie                                                     | Emplacement                     | Suppression                                                 |
| ------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------- |
| Enregistrements originaux                                     | Hors de `storage/` (référencés) | **Jamais**, par aucun code                                  |
| Projets utilisateur, exports                                  | Base + `storage/exports/`       | **Jamais automatiquement** ; seulement sur action explicite |
| Base SQLite, profils, mémoire                                 | `storage/db/`, `profiles/`      | Jamais                                                      |
| Dérivés `cache` (WAV, pistes de clip, formes d'onde, proxies) | `storage/processing/`           | Oui : tous régénérables                                     |
| Dérivés `keep` (épinglés)                                     | `storage/processing/`           | Non, tant qu'ils sont épinglés                              |
| Fichiers temporaires `*.part`                                 | `storage/processing/`           | Oui, s'ils n'appartiennent à aucun traitement actif         |
| Fichiers orphelins (sur disque mais pas en base)              | `storage/processing/`           | Oui, après un délai de grâce (1 h)                          |

Garde-fous :

1. Le nettoyage n'opère **que** dans `storage/processing/`, après vérification du chemin résolu
   (même fonction que pour l'écriture).
2. Il ne touche **jamais** un fichier déclaré par un traitement actif (`job_files`), ni un dérivé
   épinglé. Plus tard, il ne touchera pas non plus un fichier ouvert par l'éditeur (baux avec
   expiration, prévus à l'étape 7).
3. La sélection des candidats et la suppression des lignes en base se font dans une transaction.
   Un traitement qui trouve un dérivé disparu le régénère : un dérivé absent du disque est
   considéré comme absent du cache.
4. **Simulation par défaut** : la commande de nettoyage liste ce qu'elle supprimerait avant toute
   action réelle.

Automatismes :

- au démarrage : suppression des `*.part` (aucun traitement n'est alors actif) ;
- éviction **LRU** des dérivés `cache` lorsque leur total dépasse `CACHE_MAX_GB` (30 Go par défaut).

Visibilité :

- `GET /api/storage` : espace par catégorie et par usage, par enregistrement, fichiers temporaires,
  orphelins, taille de la base, **espace libre du disque** ;
- `npm run storage` (rapport) et `npm run storage -- --clean` (simulation puis confirmation) ;
- `npm run doctor` : ajout de l'espace libre.

### 7.4 Modèle temporel (implémentation : package `timeline`)

**Définitions**

- `SourceMs` : temps dans l'original, celui de la transcription, des dérivés et de FFmpeg.
- `EditMs` : temps dans le clip monté.
- Le **temps média** d'un dérivé reste interne à `@acs/media`.

**Segments** : liste ordonnée, seul pont entre les deux temps.

```ts
| { id, kind: 'source', srcStartMs: SourceMs, srcEndMs: SourceMs, speed: number /* 1 par défaut */ }
| { id, kind: 'freeze', srcAtMs: SourceMs, editDurMs: number }
```

- Durée de montage d'un segment : `(srcEnd − srcStart) / speed`, ou `editDurMs` pour un arrêt sur image.
- Positions en temps montage : **somme cumulée**, recalculée à chaque modification, jamais stockée.

**Ancrage des éléments**

- `anchor: 'source'` : sous-titres, zooms de réaction, effets sonores liés à un événement.
- `anchor: 'edit'` : titre, musique, carton de fin, avec une référence `from: 'start' | 'end'`.
  Un carton de fin reste ainsi collé à la fin si le clip raccourcit.
- Transitions : liées à la frontière entre deux segments (identifiants).

**Comportement garanti dans les cas demandés**

| Cas                                                              | Comportement                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coupes multiples                                                 | Les passages coupés n'ont aucune position de montage : `sourceToEdit` renvoie une liste vide, et les éléments ancrés au contenu de ces passages ne sont pas affichés.                                                                                                                                                                 |
| Déplacement de segments                                          | Les positions sont recalculées. Les éléments ancrés au contenu **suivent leur segment** ; ceux ancrés au montage gardent leur position.                                                                                                                                                                                               |
| Replays                                                          | La même plage source apparaît dans plusieurs segments : `sourceToEdit` renvoie **toutes** les occurrences. Chaque type d'élément définit s'il s'affiche à toutes les occurrences (sous-titres) ou seulement à la première.                                                                                                            |
| Arrêts sur image                                                 | Le temps de montage avance, le temps source reste figé (`editToSource` renvoie `srcAtMs`). Les éléments actifs à `srcAtMs` restent affichés, figés ; l'audio source est coupé pendant l'arrêt.                                                                                                                                        |
| Durée des segments modifiée (rognage, vitesse, durée d'un arrêt) | Les segments suivants se décalent automatiquement. Les éléments ancrés au contenu restent sur leur contenu ; ceux ancrés au montage gardent leur position, ou leur distance à la fin s'ils sont ancrés en `end`. Un élément ancré au montage qui sortirait du clip est **signalé** par la validation, jamais déplacé silencieusement. |

**Arrondis** : millisecondes entières. Avec `speed ≠ 1`, les conversions arrondissent à la
milliseconde la plus proche. Conversion en image au rendu : `floor(editMs × fps / 1000)`.

**Invariants vérifiés par la validation du projet** :

- `srcStart < srcEnd`, dans la durée de l'enregistrement ;
- durées strictement positives ;
- vitesse comprise entre 0,25 et 4 ;
- chevauchements de plages source autorisés (replays) ;
- aucun trou en temps montage (impossible par construction).

**Tests prévus**, en plus des cas ci-dessus : tests de propriétés sur des montages générés
aléatoirement. Pour tout temps source présent dans un segment, `editToSource(sourceToEdit(t)[i]) = t`
(à l'arrondi près si `speed ≠ 1`). La durée totale est égale à la somme des durées. Les
conversions sont monotones à l'intérieur d'un segment.

## 8. Transcription (étape 3)

Détails et compromis : `docs/transcription.md`.

| Décision                                                                                                                            | Raison                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Worker Python **persistant** piloté par Node (JSON par ligne), modèle chargé une fois par traitement                                | Faster-Whisper n'existe qu'en Python ; Node garde la logique (blocs, transactions) testable sans modèle              |
| **Node pilote les blocs**, le worker ne transcrit qu'une tranche du WAV dérivé                                                      | Atomicité et reprise gérées côté base ; le worker reste sans état (hors modèle et langue)                            |
| Zone centrale + chevauchement avant/après, attribution par **point central** avec tolérance, déduplication temporelle approximative | Ni perte ni doublon aux frontières malgré les variations de Whisper (vérifié par tests de propriétés)                |
| Segments + bloc + checkpoint dans **une transaction**, checkpoint attendu vérifié, pas d'`INSERT OR IGNORE`                         | Le checkpoint n'avance jamais si le bloc n'est pas enregistré ; `OR IGNORE` masquerait aussi les violations de CHECK |
| Périphérique réel enregistré **par bloc**                                                                                           | Une transcription partiellement CPU n'est jamais présentée comme GPU                                                 |
| Clé de cache = audio d'entrée + modèle + paramètres ; clé de comparaison = idem sans le modèle                                      | Réutilisation sans retranscrire ; comparaison des modèles à paramètres égaux                                         |
| Métriques brutes conservées, `suspicion_score` heuristique séparé                                                                   | Les sorties de Whisper ne sont pas des probabilités calibrées                                                        |
| Transcriptions = données permanentes ; WAV d'entrée = cache                                                                         | Le nettoyage ne supprime jamais une transcription ; le WAV reste réutilisable                                        |
| Tests : faux worker (même protocole) en CI Linux/Windows ; vrai modèle `tiny` sur CPU dans un job dédié                             | Couverture complète sans GPU ; le GPU se valide sur la machine du créateur (`doctor --gpu`)                          |

## 9. Analyse éditoriale, étape 4a (préparation locale)

Détails, utilisation et limites : `docs/analyse-editoriale.md`.

| Décision                                                                                                    | Raison                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Étape 4 découpée en **4a (locale, sans appel)** puis **4b (Claude)**                                        | Le créateur valide le repérage et le contenu qui serait envoyé avant toute dépense et toute transmission                     |
| Signaux **factuels** uniquement (`nature: 'mesure'`), interface `SignalProvider`                            | Claude ne reçoit pas le son ; un pic sonore n'est pas une émotion. Un analyseur audio local pourra s'ajouter sans réécriture |
| Score local pondéré vers les **interactions** ; le volume seul ne crée jamais de fenêtre                    | La priorité éditoriale est l'humour et les échanges, pas les cris ni les éliminations                                        |
| Texte Discord / piste « tout » **retenu par défaut**, accord par enregistrement avec note datée             | Voix d'autres personnes ; seuls les instants de parole sont indiqués sans accord                                             |
| Pseudonymisation par liste locale (hors dépôt) + masquage e-mails, liens, numéros, mentions                 | Aucun nom réel transmis ni versionné ; limite assumée : un nom non listé n'est pas détecté                                   |
| Images seulement avec un **profil de cadrage validé** (empreinte), zones et facecam en **aplat opaque**     | La facecam est souvent incrustée dans l'image de jeu ; un flou peut laisser lire un pseudo                                   |
| Contenu préparé **écrit sur disque** (`storage/analysis/`), hors `processing/`                              | Consultable avant tout envoi ; jamais supprimé par le nettoyage du cache                                                     |
| Transcriptions encadrées comme **données non fiables**, neutralisées ; pseudo-consignes marquées            | Une phrase prononcée en stream ne doit jamais devenir une instruction                                                        |
| Tarifs versionnés ; modèle sans tarif = préparation bloquée ; pire cas = sortie maximale réflexion comprise | Le plafond de réservation (5 $) est vérifié avant chaque appel (4b) ; la base refuse `dépensé + réservé > budget`            |
| Nouvelle file de traitements `analysis`                                                                     | L'analyse ne doit pas attendre la transcription GPU d'un autre enregistrement (et inversement)                               |

## 10. Analyse avec Claude, étape 4b

Détails : `docs/analyse-editoriale.md` § 11.

| Décision                                                                                                                                                | Raison                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| SDK officiel épinglé (version publiée depuis plus de deux semaines), `maxRetries: 0`                                                                    | Chaque tentative doit être réservée au budget ; une tentative automatique du SDK pourrait être facturée sans réservation        |
| Interface `EditorialModel` (vrai Claude / faux modèle) ; le vrai client refuse `NODE_ENV=test`                                                          | La CI ne peut jamais appeler l'API ; toute la chaîne est testable                                                               |
| Réservation du pire cas en transaction, contrainte CHECK en base, `overrun_usd` en dernier recours                                                      | Plafond de réservation tenu même avec plusieurs appels simultanés ; le coût réel au-delà est isolé, affiché et arrête l'analyse |
| Requêtes réelles écrites dans `requetes/` avant envoi ; **pause de relecture** après le repérage (défaut) ; empreinte comparée juste avant chaque envoi | Les requêtes Opus dépendent de la réponse de Haiku : seule une pause permet de les relire avant leur envoi                      |
| Empreinte de requête → réutilisation des réponses (réussies, refusées, tronquées) entre analyses                                                        | Reprise et relance sans double paiement ; un refus n'est jamais contourné                                                       |
| Identifiants de segments au lieu d'instants ; citations vérifiées mot à mot ; bornes recalculées localement                                             | Claude ne peut ni inventer une parole ni un instant                                                                             |
| Pertinence (Claude) et fiabilité (calcul local) séparées                                                                                                | Un moment drôle mais mal transcrit n'est jamais présenté comme un clip fiable                                                   |
| Requêtes exactes écrites par le dry-run, vérifiées identiques au lancement                                                                              | Tout ce qui part est consultable avant tout appel                                                                               |
| Branche empilée sur la 4a (écart ponctuel validé par le créateur)                                                                                       | La 4b dépend du code de la 4a, pas encore fusionné                                                                              |

## 11. Validation des propositions et mémoire éditoriale v1, étape 5

Détails : `docs/validation-propositions.md`.

| Décision                                                                                                                                                                    | Raison                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Paquet `@acs/memory` en TypeScript pur (motifs, machine d'états, moments, décision effective)                                                                               | Règles testables sans base ni interface, réutilisables à l'étape 6                                               |
| Trois niveaux séparés : propositions (`clip_proposals`, lecture seule), décisions courantes (`proposal_reviews`, source de vérité), journal (`feedback_events`, ajout seul) | Les retours restent exploitables même si une analyse est supprimée ; aucune réécriture de l'historique           |
| Ancienne colonne de statut de `clip_proposals` jamais lue (test d'architecture et canari)                                                                                   | Une migration publiée ne se modifie pas ; aucune valeur obsolète ne peut s'afficher                              |
| Moments à référence figée, appartenances jamais modifiées, détachement explicite et tracé                                                                                   | Pas d'effet de chaîne, regroupements stables, aucune décision héritée silencieusement fausse                     |
| Décision effective = dernier événement du moment ; annulation réservée à la proposition source                                                                              | Une annulation ne fait jamais réapparaître une décision plus ancienne ni ne défait celle d'une autre proposition |
| Demandes idempotentes (`review_requests`, réponse d'origine rejouée), concurrence par version                                                                               | Double-clic, nouvel essai, deux onglets : aucun doublon d'événement                                              |
| Écoute par le profil `preview` (cache et file existants) ; lecture HTTP `Range` ; fichier servi vérifié (chemin en base, `processing/`, pas de lien)                        | Écoute locale fiable sans exposer de chemin ni modifier l'original ; la vidéo reste pour l'étape 7               |
| Aucun accès au journal pendant une analyse (`memory_version` nulle, mêmes requêtes Claude)                                                                                  | Aucune préférence n'est déduite ni activée avant l'étape 6                                                       |

## 12. Moteur de rendu, étape 6a (projet de clip et persistance)

Plan complet : `docs/plan-etape-6.md`. L'étape 6 est livrée en trois PR : 6a (projet de clip et
persistance, ici), 6b (rendu FFmpeg), 6c (interface).

| Décision                                                                                                                                           | Raison                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ClipProject` v1 dans `@acs/timeline` (Zod strict, `schemaVersion`), créé seulement depuis une proposition dont la décision effective est acceptée | Document unique lu par le rendu (6b) puis par l'éditeur (7) ; aucune décision de revue copiée dans le document                 |
| Segments, sous-titres et repères en temps source ; temps montage déduit via les segments                                                           | `SourceMs` et `EditMs` ne sont jamais mélangés ; les sous-titres suivront les coupes de l'étape 7                              |
| Révisions immuables (`clip_project_revisions`), concurrence par `baseRevision`, idempotence par `requestId`                                        | Historique complet, base de l'annuler/rétablir, aucune perte en cas de double clic ou de deux onglets                          |
| Un projet par moment (décision héritée ⇒ projet de la proposition source)                                                                          | Pas de doublon de clip pour un même moment                                                                                     |
| Décision effective revérifiée sous le verrou d'écriture (`BEGIN IMMEDIATE`) ; transactions de revue en `BEGIN IMMEDIATE`                           | Décisions et écritures des projets (puis publication des exports en 6b) totalement ordonnées, y compris entre API et CLI       |
| Audio exporté : consentements par catégorie de voix de tiers et déclarations de composition, en journal ajout seul (`export_audio_events`)         | Aucune piste (« tout », jeu, **micro** compris) ne contourne le consentement ; distinct de l'accord d'envoi à Claude (étape 4) |
| Règle `allowedAudio()` pure dans `@acs/render`, revérifiée à chaque lecture et à chaque modification                                               | Un document ne peut jamais ajouter une piste ou des sous-titres non autorisés                                                  |
| Sous-titres préparés sur la fenêtre ±10 s ; corrections du créateur à part (texte d'origine conservé) ; pseudonymisation du texte affiché          | Pas de dialogue inventé ni de transcription réécrite ; les noms protégés ne s'affichent pas                                    |
| Manifeste d'intégrité (`@acs/media`, `source_integrity_manifests`) : SHA-256 d'un ensemble d'octets exact, vérifié sans FFmpeg                     | Détecte toute modification utile au clip, même avec taille et date restaurées ; suffisance prouvée par test (reste à zéro)     |
| Bornes absolues 5–180 s ; hors plage effective (20–80 s par défaut) : confirmation liée à la révision ; ajustement ±10 s calé sur les mots         | Décisions du créateur (§ 14 du plan) ; une confirmation ne survit pas à une modification des bornes                            |

## 13. Moteur de rendu FFmpeg, étape 6b

Plan : `docs/plan-etape-6.md` (§ 6.5–6.9, § 7, et § 18 pour les écarts de la PR 6b).

| Décision                                                                                                                                                                                                                                                    | Raison                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Rendu 100 % FFmpeg ; plan de rendu pur et sérialisable (`@acs/render`), exécution isolée dans `run.ts`                                                                                                                                                      | Même plan pour l'aperçu et l'export ; un futur aperçu interactif (étape 7) pourra lire le même plan                            |
| Graphe de filtres construit uniquement à partir de nombres validés et de noms relatifs fixes (`subs.ass`, `fonts`) ; FFmpeg lancé sans shell, `cwd` = dossier de travail                                                                                    | Aucune injection possible ; aucun chemin Windows à échapper ; l'original n'est qu'un argument `-i`                             |
| Aplats opaques sur l'image source avant tout recadrage (fonction partagée avec `frames.ts`)                                                                                                                                                                 | Une zone sensible ne réapparaît dans aucun calque (fond flouté, facecam)                                                       |
| Sous-titres ASS (libass) avec polices OFL fournies, texte neutralisé (`\`, `{`, `}`, contrôles) ; karaoké seulement sur un texte exact                                                                                                                      | Rendu identique partout ; aucune balise injectable ; aucun mot inventé ni perdu                                                |
| Le plan revérifie durée, audio exporté et sous-titres quel que soit le document                                                                                                                                                                             | Un document modifié ou un accord révoqué ne peut jamais produire un export non autorisé                                        |
| `-14 LUFS` (`loudnorm`) par défaut, désactivable ; fréquence source plafonnée à 60 i/s ; `-ss` avant `-i` avec ré-encodage                                                                                                                                  | Décisions du créateur ; coupe précise à l'image près (testée)                                                                  |
| Effets : ancrage éditorial + indice technique (énergie du micro), au plus 2, jamais en fidèle hors mise en évidence de la chute                                                                                                                             | Aucun effet arbitraire ; raison affichée « indice technique, à vérifier »                                                      |
| Publication sous le verrou d'écriture (`BEGIN IMMEDIATE`) : décision, révision et accords revérifiés, puis renommage de la zone d'attente                                                                                                                   | Une proposition refusée ne peut jamais faire apparaître un export ; un fichier n'est un export que si sa ligne est `succeeded` |
| Récupération au démarrage des rendus `finalizing`, attendue avant tout travail : plan recalculé (accords, déclarations, confidentialité) d'empreinte identique, puis décision, révision et état audio revérifiés sous verrou ; sinon retrait ou quarantaine | Aucun export fantôme après un arrêt ; jamais de publication après le retrait d'un accord                                       |
| Aperçus = cache évinçable (LRU) ; rendus actifs protégés ; `exports/` jamais parcouru par le nettoyage                                                                                                                                                      | Les exports finaux ne sont jamais supprimés automatiquement                                                                    |

## 14. Interface des clips, étape 6c

Guide : `docs/rendu-clips.md`. Plan : `docs/plan-etape-6.md` (§ 10 et § 19).

| Décision                                                                                                                                                                              | Raison                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| L'interface n'applique aucune règle d'audio ni de consentement : elle affiche la décision du serveur et ne propose l'ajout que des pistes de `audio.selected`                         | Une seule source de vérité ; le serveur revérifie tout sous verrou                         |
| Réglages envoyés un par un sur la dernière révision confirmée ; brouillons locaux ; même `requestId` au nouvel essai ; conflit → rechargement sans perte puis réapplication explicite | Aucune modification perdue ni écrasée, aucun doublon                                       |
| Image fixe : abandon côté client, arrêt effectif de FFmpeg côté serveur (déconnexion, demande plus récente), plafond de 2 générations, réponses obsolètes ignorées                    | Pas d'accumulation de FFmpeg inutiles ; l'image affichée est toujours la dernière demandée |
| Effets uniquement à la demande, nouveaux effets désactivés, états existants jamais modifiés                                                                                           | Tout effet résulte d'une action explicite du créateur                                      |
| Lecture seule stricte quand la décision n'est plus acceptée ; exports antérieurs consultables avec avertissement                                                                      | La revue reste la source de vérité ; aucun export n'est perdu                              |

## 15. Éditeur avec timeline, étape 7 (PR 7a : modèle et opérations)

Plan : `docs/plan-etape-7.md` (§ 14 pour les précisions de mise en œuvre).

| Décision                                                                                                                                                                                     | Raison                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Projet de clip v2 (`@acs/timeline/v2`) : segments source, arrêt sur image et vide ; fenêtre éditable liée à un manifeste d'intégrité ; masques toujours opaques ; `blur_region` simple effet | Une seule source de vérité pour l'éditeur, l'aperçu et l'export ; aucune règle de l'étape 6 affaiblie            |
| Opérations typées, lectures et écritures par clé d'état, préconditions, inverse `restore` conditionnel, invariants après chaque opération                                                    | Le même réducteur sur l'interface et le serveur ; annuler sûr et exact, jamais de correction silencieuse         |
| Historique linéaire par projet déduit du journal ; réapplication automatique seulement si l'indépendance est démontrée dans les deux sens et que les deux ordres donnent le même document    | Annuler fiable après rechargement et entre onglets ; aucune perte, aucun écrasement                              |
| Géométrie et description de scène pures, partagées par le moteur FFmpeg et l'aperçu                                                                                                          | Ce qui est vu dans l'éditeur correspond à l'export                                                               |
| Journal d'édition en ajout seul + points de contrôle (migration 8) ; document courant = point de contrôle + rejeu vérifié ; écriture sous `BEGIN IMMEDIATE` (PR 7b)                          | Annuler après rechargement, plusieurs onglets, aucune réécriture ; un journal altéré est détecté, jamais corrigé |
| Transition : projection v1 exacte pour l'interface 6c, le PATCH v1 et le moteur de l'étape 6 ; `EDITOR_REQUIRED` sinon                                                                       | Rien ne casse avant les PR 7c et 7e ; aucune projection approximative                                            |
| Moteur multi-segments (PR 7c) : le rendu lit le document v2 ; une entrée FFmpeg par segment, coupes sur la grille d'images, arrêt sur image et vide en silence numérique, raccords de 8 ms   | Coupes exactes sans dérive, synchronisation après chaque coupe, réordonner sans mémoire tampon                   |
| Graphe FFmpeg lu depuis un fichier du dossier de travail ; un projet d'un segment garde le graphe de l'étape 6 (même empreinte de plan)                                                      | Plus de limite de ligne de commande sous Windows ; rendus et exports existants reconnus à jour                   |
| Fonctions de l'éditeur pas encore rendues : refus explicite `RENDER_FEATURE_UNSUPPORTED` ; fenêtre éditable ±60 s, élargie seulement par le serveur avec un nouveau manifeste                | Jamais d'élément ignoré en silence ; l'intégrité de la source couvre toujours tout ce qui est rendu              |
