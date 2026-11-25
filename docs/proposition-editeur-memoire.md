# Proposition : éditeur vidéo manuel et mémoire éditoriale

> **Statut : architecture validée.** Les fondations (§ 10 : dérivés, file de traitements, modèle
> temporel) sont implémentées ; la capture des retours (mémoire v1, couche 1) est implémentée à
> l'étape 5 (`docs/validation-propositions.md`) ; le moteur de rendu est l'étape 6
> (`docs/plan-etape-6.md`) ; l'éditeur complet est l'étape 7 ; la suite de la mémoire reste à
> planifier. **Feuille de route renumérotée le 24/11/2026** (§ 5).
> Date : 23 novembre 2026. Base : cahier des charges v1.2, plan technique v1.0, code des étapes 1 et 2.

## 1. Résumé

Les deux nouvelles exigences reposent sur **une même idée centrale** : un **document de montage**
déclaratif, versionné et validé (le _projet de clip_), qui devient la source unique de vérité pour :

```
 Claude (propositions) ──► Projet de clip (JSON validé) ◄── Éditeur manuel (opérations)
                                   │
              ┌────────────────────┼─────────────────────┐
              ▼                    ▼                     ▼
   Prévisualisation          Export final        Historique des opérations
   (Remotion Player,         (Remotion Renderer,  (annuler / rétablir)
    navigateur)               même code)                 │
                                                         ▼
                                              Mémoire éditoriale
                                   (événements → statistiques → préférences validées)
                                                         │
                                                         ▼
                                            Prochaines analyses Claude
```

Conséquences :

- **Prévisualisation = export** : la même composition Remotion sert à l'aperçu dans le navigateur
  et au rendu final. Aucune divergence entre ce que l'on voit et ce qui est exporté.
- **L'IA ne produit que des données** : Claude propose un projet de clip (choix parmi un catalogue
  d'effets aux paramètres validés). Rien n'est exécuté directement, conformément au cahier des charges.
- **L'historique sert deux fois** : chaque modification est une opération enregistrée. Elle permet
  l'annulation **et** alimente l'apprentissage (« a supprimé le zoom », « a allongé le début de 3 s »).

## 2. Impact sur l'existant (étapes 1 et 2)

**Rien n'est à reconstruire.** Les choix déjà faits sont compatibles :

| Existant                                                        | Compatibilité                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Monolithe modulaire (packages + une API)                        | Ajout de packages, aucun service supplémentaire.                        |
| Temps de référence = timeline de l'enregistrement (WAV alignés) | C'est exactement la référence dont l'éditeur a besoin.                  |
| Import par référence + empreinte                                | Les projets de clip pointent vers l'enregistrement, pas vers une copie. |
| File de traitements générique (`JobRunner`)                     | Nouveaux types : `proxy`, `waveform`, `render`.                         |
| Rôles des pistes (`mic`, `discord`, `game`, `mix`)              | Réutilisés pour le mixage par piste.                                    |
| Schémas Zod stricts                                             | Étendus au projet de clip, aux effets, aux événements de mémoire.       |

**Un point à réviser : vos pistes OBS.** Pour régler séparément le volume du jeu, du micro et de
Discord dans l'éditeur, il faut une piste **jeu sans voix**. Avec la configuration actuelle
(« tout » + micro + Discord), on peut renforcer une voix, mais pas baisser le jeu ou une voix
indépendamment. Recommandation : **ajouter une 4e piste « Jeu »** (jeu + navigateur, sans micro
ni Discord) et **ne pas modifier la piste « tout »**, qui sert probablement au stream. Les anciens
enregistrements resteront éditables, avec un réglage de volume global uniquement.

## 3. Architecture cible

```
packages/
  shared/        types communs, erreurs                          (existant)
  media/         FFmpeg : métadonnées, audio, + proxies, formes d'onde   (étendu)
  transcription/ Faster-Whisper                                   (étape 3)
  editorial/     prompts, Claude, propositions                    (étape 4)
  timeline/      NOUVEAU — modèle du projet de clip : schéma, opérations,
                 historique, validation, migrations de version (TS pur, front + back)
  render/        NOUVEAU — compositions Remotion + catalogue d'effets
                 (utilisé par le Player du navigateur ET le rendu serveur)
  memory/        NOUVEAU — mémoire éditoriale : événements, agrégation,
                 préférences, construction du contexte pour Claude
apps/web/        validation des propositions, puis éditeur
services/api/    routes projets, révisions, ressources, retours, préférences ; travaux proxy/rendu
storage/
  assets/        NOUVEAU — images, memes, effets sonores (bibliothèque locale)
  processing/    + proxies et formes d'onde par clip
```

`timeline` et `memory` sont du **TypeScript pur sans dépendance à React ni à Node** : testables
unitairement, partagés entre l'interface et le serveur.

### 3.1 Le projet de clip (`packages/timeline`)

Principes du modèle :

- **Deux temps distincts, jamais mélangés** (détail au § 10.2) :
  - **temps source** (`SourceMs`) : position dans l'enregistrement original. C'est le temps de la
    transcription, des WAV extraits et de FFmpeg ;
  - **temps montage** (`EditMs`) : position dans le clip exporté (0 = première image du clip).
- **Millisecondes entières** (aucune dérive de virgule flottante).
- **Coordonnées normalisées (0 à 1)**, elles aussi dans deux repères distincts : `crop` dans
  l'image source, `frame` dans l'image de sortie 9:16.
- **`schemaVersion` + migrations** : un projet créé aujourd'hui restera ouvrable après évolution du format.
- **Identifiants stables** pour chaque élément (nécessaires à l'historique et à l'apprentissage).

Esquisse (non définitive) :

```ts
type SourceMs = number & { __brand: 'SourceMs' }   // temps dans l'original
type EditMs   = number & { __brand: 'EditMs' }     // temps dans le clip monté

// Placement d'un élément : ancré au contenu (suit les coupes) ou à la structure du montage.
type Timing =
  | { anchor: 'source'; srcStartMs: SourceMs; srcEndMs: SourceMs }
  | { anchor: 'edit';   editStartMs: EditMs;  editEndMs: EditMs }

ClipProject {
  schemaVersion: 1
  id, recordingId, proposalId?, gameId, mode: 'fidele' | 'enrichi'
  output: { width: 1080, height: 1920, fps: 60 }

  // SEUL pont entre les deux temps. Les positions en temps montage sont DÉDUITES
  // (concaténation dans l'ordre), jamais stockées : aucune incohérence possible.
  segments: [
    | { id, kind: 'source', srcStartMs, srcEndMs }          // coupe (début/fin modifiables)
    | { id, kind: 'freeze', srcAtMs, editDurMs }            // arrêt sur image : avance le montage, pas la source
  ]

  captions:    [{ id, timing: Timing /* toujours 'source' */, text, words?, style }]
  effects:     [{ id, type, timing: Timing, params }]       // zoom de réaction → 'source'
  overlays:    [{ id, type: 'image' | 'meme' | 'text', assetId?, timing: Timing, frame: Rect }]
  transitions: [{ id, type, betweenSegments: [idA, idB], durMs, params }]   // liées à la structure
  layout:      [{ id, timing: Timing, layers: [{ role: 'gameplay' | 'facecam', crop: Rect, frame: Rect }] }]
  audio: {
    tracks: [{ audioIndex, role, gainDb, muted, automation?: [{ srcAtMs, gainDb }] }]
    sfx:    [{ id, assetId, timing: Timing, gainDb }]
  }
  origin: { by: 'ai' | 'user', analysisRunId? }
}
```

Les sous-titres sont initialisés depuis la transcription (étape 3) : **le texte proposé ne peut
venir que de la transcription**. Toute modification manuelle est tracée.

### 3.2 Catalogue d'effets (`packages/render`)

Chaque effet est déclaré une seule fois :

```ts
defineEffect({
  type: 'zoom',
  category: 'emphase',
  description: 'Zoom rapide sur une zone pour souligner une réaction', // lu par Claude
  params: z.object({ target: Rect, scale: z.number().min(1).max(3), easing: … }),
  component: ZoomEffect,      // composant Remotion (aperçu + export)
})
```

- Ajouter un effet = ajouter un fichier. Aucune modification de l'éditeur ou du pipeline.
- Claude ne peut proposer **que** des types du catalogue, avec des paramètres validés.
- Le mode **fidèle** et le mode **enrichi** sont des _préréglages_ : un ensemble d'effets autorisés
  et une intensité par défaut.

### 3.3 Historique et annulation

- Chaque action de l'éditeur est une **opération typée** (`trimSegment`, `updateCaption`,
  `moveLayer`, `addEffect`…), appliquée au document via Immer, qui produit le correctif
  (_patch_ JSON) et son inverse.
- **Annuler / rétablir** en mémoire, immédiatement.
- **Persistance** : table `project_revisions` (numéro, opération, correctif, correctif inverse,
  auteur `ai` ou `user`, date), plus un instantané complet périodique pour un chargement rapide.
- Le premier état d'un projet issu d'une proposition porte l'auteur `ai` : la différence entre
  cette version et la version exportée est **exactement** l'ensemble des corrections du créateur.

### 3.4 Prévisualisation et médias de travail

Les navigateurs lisent mal les MKV, ne gèrent pas plusieurs pistes audio et ne peuvent pas se
déplacer efficacement dans un fichier de 8 h. Pour chaque clip ouvert dans l'éditeur :

- **Fenêtre de travail** : extrait de l'original couvrant le clip ± une marge (pour pouvoir
  élargir les points d'entrée et de sortie).
- **Proxy vidéo** H.264 léger pour l'aperçu, **pistes audio séparées** (mic, Discord, jeu) pour
  le mixage, **formes d'onde** précalculées pour la timeline.
- L'**export** relit l'original en pleine qualité, aux mêmes temps : le proxy ne sert qu'à l'affichage.

Ces fichiers sont générés par la file de traitements existante et restent dans `storage/processing/`.

## 4. Mémoire éditoriale (`packages/memory`)

**Aucun entraînement de modèle.** Il s'agit d'un système de mémoire structurée, transparente et
modifiable, en quatre couches.

### 4.1 Couche 1 : événements (signaux bruts)

Table `feedback_events`, horodatée, rattachée à l'enregistrement, au jeu, à la proposition ou au projet :

| Événement                                            | Source                        |
| ---------------------------------------------------- | ----------------------------- |
| Proposition acceptée / refusée                       | Écran de validation (étape 5) |
| **Raison du refus** (choix + commentaire libre)      | Écran de validation           |
| Correction de début / fin (avec écart en ms)         | Opérations de l'éditeur       |
| Effet ajouté / supprimé / modifié (type, paramètres) | Opérations de l'éditeur       |
| Style de sous-titres, mise en page, volumes modifiés | Opérations de l'éditeur       |
| Clip exporté (signal positif fort)                   | Export                        |

Raisons de refus proposées : `pas_drole`, `manque_de_contexte`, `chute_coupee`, `trop_long`,
`trop_court`, `deja_vu`, `gameplay_sans_interet`, `audio_inaudible`, `contenu_a_eviter`, `autre`.
Le commentaire libre reste toujours possible.

### 4.2 Couche 2 : statistiques (calcul déterministe, sans IA)

Calculées par jeu et globalement, explicables et reproductibles :

- taux d'acceptation par catégorie (humour, malentendu, réaction…) ;
- ajustement moyen des points d'entrée et de sortie (« sur Valorant, vous allongez le début de 3,1 s en moyenne ») ;
- durée préférée des clips ;
- taux de conservation de chaque type d'effet (« les effets sonores proposés sont supprimés 7 fois sur 10 ») ;
- styles de sous-titres et mises en page les plus utilisés.

### 4.3 Couche 3 : préférences (règles validées)

Table `preferences` :

```
{ id, scope: 'global' | 'game:valorant', kind: 'selection' | 'montage' | 'style' | 'a_eviter',
  statement: "Toujours garder la mise en place d'un malentendu, même si elle dure 15 s",
  evidence: [ids d'événements], stats, confidence,
  status: 'suggeree' | 'active' | 'refusee' | 'archivee', source: 'createur' | 'deduite' }
```

- Vous pouvez **écrire une préférence directement**.
- Le système peut **suggérer** une préférence, à partir des statistiques ou d'un résumé de vos
  commentaires par Claude. Elle ne devient **active qu'après votre validation**. Pas de dérive
  silencieuse.
- Chaque préférence montre **ses preuves** (les clips et corrections qui l'ont fait naître) et
  reste modifiable ou archivable.
- Le profil `creator.json` (identité de base, versionnée dans Git) n'est jamais modifié
  automatiquement. La mémoire vit dans SQLite et peut être exportée en JSON.

### 4.4 Couche 4 : exploitation lors des analyses

À chaque analyse, `memory` construit un contexte **borné en jetons** :

1. préférences actives (globales + celles du jeu) ;
2. résumé des statistiques utiles ;
3. quelques **exemples** : clips validés ou exportés (extrait de transcription + raison) et
   **contre-exemples** refusés (avec la raison du refus), choisis selon le jeu et la catégorie.

Chaque analyse enregistre la **version de la mémoire utilisée** (`analysis_runs`), pour mesurer à
l'étape d'évaluation si la mémoire améliore réellement les propositions, et pour revenir en
arrière si une préférence les dégrade.

## 5. Feuille de route révisée

Le principe du plan technique est conservé : **valider le cerveau éditorial avant de construire
le montage**. Les fondations de données sont posées tôt pour ne rien reconstruire.

| Étape       | Contenu                 | Changement                                                                                                                                                            |
| ----------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1           | Initialisation          | ✅ terminée                                                                                                                                                           |
| 2           | Import et audio         | ✅ terminée                                                                                                                                                           |
| 3           | Transcription           | ✅ terminée                                                                                                                                                           |
| 4           | Analyse éditoriale      | ✅ terminée (4a préparation locale, 4b Claude)                                                                                                                        |
| 5           | Interface de validation | ✅ terminée : raisons de refus, événements (mémoire v1 : capture)                                                                                                     |
| 6           | **Moteur de rendu**     | Remplace l'ancienne étape 7 « moteur de montage » : projet de clip, rendu **FFmpeg seul**, 9:16, sous-titres, cadrage, effets sobres, aperçu et export (6a, 6b, 6c)   |
| 7           | **Éditeur complet**     | Regroupe les anciennes étapes 8 et 9 : timeline, outils de montage, aperçu interactif (Remotion réévalué à ce moment), historique et annulation sur le projet de clip |
| à planifier | Évaluation + mémoire v1 | Ancienne étape 6 (préférences manuelles, statistiques, injection dans le prompt) : position à confirmer par le créateur                                               |
| à planifier | Mémoire v2              | Ancienne étape 10 (apprentissage à partir des corrections du montage) : position à confirmer                                                                          |

Renumérotation décidée par le créateur le 24/11/2026 (`docs/plan-etape-6.md` § 14). Les sections
ci-dessus qui citent « l'étape 7 » pour le moteur de montage ou « l'étape 8 » pour l'éditeur
renvoient à l'ancienne numérotation.

## 6. Choix techniques supplémentaires envisagés

| Besoin                | Proposition                                                                                  | Justification                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aperçu et export      | **Remotion** (`@remotion/player`, `@remotion/renderer`)                                      | Déjà imposé par le cahier des charges ; même code pour l'aperçu et l'export. **Licence** : gratuite pour les particuliers et les petites structures selon les conditions publiées par Remotion, **à vérifier** avant l'étape 7. **Décision du 24/11/2026 : rendu FFmpeg seul à l'étape 6 ; Remotion réévalué à l'étape 7 pour l'aperçu interactif.** |
| État de l'éditeur     | **Zustand + Immer**                                                                          | Léger, et Immer produit nativement les correctifs nécessaires à l'historique.                                                                                                                                                                                                                                                                        |
| Composant de timeline | Composant maison sur une base simple, ou bibliothèque existante                              | Décision à prendre à l'étape 8, après prototype.                                                                                                                                                                                                                                                                                                     |
| Formes d'onde         | Pics calculés par FFmpeg, stockés en JSON                                                    | Affichage instantané, même pour un clip long.                                                                                                                                                                                                                                                                                                        |
| Mémoire               | SQLite + code déterministe ; Claude seulement pour résumer des commentaires en _suggestions_ | Transparence, coût maîtrisé, aucune décision silencieuse.                                                                                                                                                                                                                                                                                            |

## 7. Risques identifiés

| Risque                                                                 | Mesure                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Charge de développement de l'éditeur (le plus gros chantier du projet) | Découpage en 2 étapes ; v1 limitée aux réglages essentiels.                             |
| Temps de rendu Remotion (rendu image par image dans Chrome)            | Mesure dès l'étape 7 sur un clip de 60 s ; encodage NVENC possible.                     |
| Lecture de l'original dans le navigateur                               | Proxies et pistes audio séparées (§ 3.4).                                               |
| Préférences mal déduites ou trop spécifiques                           | Validation humaine obligatoire, preuves visibles, portée par jeu, archivage.            |
| Droits d'auteur des memes, images et sons                              | Bibliothèque locale fournie par le créateur ; responsabilité rappelée dans l'interface. |
| Coût des appels Claude quand la mémoire grossit                        | Contexte borné en jetons, exemples sélectionnés, mesure des coûts par analyse.          |

## 8. Mises à jour proposées des documents de référence

Les fichiers `.docx` ne sont pas dans le dépôt. Voici les modifications à y reporter, ou à
intégrer dans `docs/` si vous préférez versionner ces documents avec le code.

### Cahier des charges v1.2 → v1.3

- **Vision** : ajouter « … et permet de les retravailler dans un éditeur intégré ; l'outil apprend
  progressivement les préférences du créateur à partir de ses validations et corrections ».
- **Périmètre fonctionnel**, nouvelles lignes :
  - _Éditeur manuel_ : timeline multipiste avec aperçu ; début et fin ; sous-titres (texte,
    couleur, taille, timing) ; facecam (position, taille) ; recadrage du gameplay ; zooms, effets,
    transitions, images, memes, effets sonores ; volumes ; aperçu avant export ; historique et annulation.
  - _Mémoire éditoriale_ : enregistrement des acceptations, refus et raisons, des corrections et des
    effets ajoutés ou retirés ; préférences générales et par jeu, validées par le créateur ;
    exploitées lors des analyses suivantes. **Pas d'entraînement de modèle.**
- **Contraintes**, ajouts : aperçu identique à l'export ; aucune préférence déduite n'est appliquée
  sans validation ; la mémoire reste locale.
- **Hors périmètre initial**, ajout : entraînement ou fine-tuning de modèles d'IA.

### Plan technique v1.0 → v1.1

- **Architecture logique**, nouvelles briques : _Timeline Model_, _Render Engine_ (Remotion),
  _Editor UI_, _Editorial Memory_.
- **Structure du projet** : ajout de `packages/timeline`, `packages/render`, `packages/memory`,
  `storage/assets`.
- **Contrat de données** : le _projet de clip_ (§ 3.1) devient le contrat entre l'analyse,
  l'éditeur, l'aperçu et l'export.
- **Découpage** : remplacer les lots E et F par les étapes 7 à 10 (§ 5).
- **Stratégie de test éditorial** : comparer la qualité des propositions **avec et sans** mémoire
  sur le jeu de référence.

## 9. Décisions attendues (première version)

1. Validez-vous l'architecture (projet de clip comme source unique, nouveaux packages
   `timeline` / `render` / `memory`) ?
2. Validez-vous la feuille de route révisée (éditeur aux étapes 7 à 9, capture des retours dès l'étape 5) ?
3. Préférences déduites : **validation obligatoire** avant activation (recommandé) ou activation automatique ?
4. Ajouterez-vous une **4e piste OBS « Jeu »** (sans voix) pour le réglage des volumes ?
5. Faut-il versionner le cahier des charges et le plan technique dans `docs/` (en Markdown) ?

## 10. Vérification des trois exigences (audit du code au 23/11/2026)

### 10.1 Pistes audio prévues pour l'éditeur, pas seulement pour Whisper

**Verdict : partiellement satisfait. Correction nécessaire.**

Vérifié sur un enregistrement de test à 4 pistes (« Tout », « Micro », « Discord », « Jeu ») :

| Élément                                                                              | État                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventaire de **toutes** les pistes (index, codec, canaux, fréquence, nom, décalage) | ✅ les 4 pistes sont enregistrées, dont `game` reconnue par son nom                                                                                               |
| Rôles `mic`, `discord`, `game`, `mix`                                                | ✅ déjà prévus                                                                                                                                                    |
| Alignement sur le temps source (silence initial, trous comblés)                      | ✅ indépendant du format de sortie                                                                                                                                |
| **Fichiers dérivés**                                                                 | ❌ un seul emplacement par piste (`audio_tracks.extracted_*`), format figé **16 kHz mono** (adapté à Whisper uniquement), pistes `game` et `mix` jamais extraites |
| **Type de traitement**                                                               | ❌ `extract_audio` signifie en réalité « audio pour Whisper »                                                                                                     |

Corrections proposées (petites, avant toute donnée réelle) :

1. **Table `media_derivatives`** (migration 2) remplaçant les colonnes `extracted_*` :
   `kind` (`audio_transcription`, `audio_stem`, `waveform`, `video_proxy`, `thumbnail`),
   `audio_index` facultatif, **plage source facultative** (`src_start_ms`, `src_end_ms` ; vide =
   tout l'enregistrement), format (fréquence, canaux, codec), chemin, durée. Une piste peut ainsi
   avoir plusieurs dérivés : WAV pour Whisper, piste de montage, forme d'onde.
2. **Profils d'extraction** dans `@acs/media` :
   - `transcription` : PCM 16 kHz mono, sur tout l'enregistrement ;
   - `editor` : 48 kHz stéréo pleine qualité, **limité à la fenêtre d'un clip**. Sur 8 h, un WAV
     48 kHz stéréo pèserait environ 5,5 Go par piste : on ne l'extrait donc que par clip.

   Même filtre d'alignement pour les deux profils.

3. **Deux politiques de sélection distinctes** :
   - Whisper : micro + Discord (sinon mix), **inchangé** ;
   - éditeur : micro + Discord + jeu si une piste `game` existe ; sinon le mix seul. Le mix n'est
     jamais superposé aux pistes de voix, sinon les voix seraient doublées.

### 10.2 Distinction temps source / temps montage

**Verdict : non satisfait dans la première version de la proposition. Corrigé au § 3.1.**

La première esquisse utilisait des champs `atMs` sans dire s'il s'agissait du temps source ou
du temps montage. Le code actuel, lui, est cohérent : il ne manipule que du temps source.
Règles retenues :

1. **Deux types distincts** `SourceMs` et `EditMs` (types « marqués » TypeScript) : le
   compilateur refuse de passer l'un pour l'autre. Champs toujours préfixés `src…` ou `edit…`.
2. **Les segments sont le seul pont** entre les deux temps. Les positions en temps montage sont
   calculées, jamais stockées.
3. **Ancrage explicite de chaque élément** :
   - au **contenu** (`anchor: 'source'`) : sous-titres, zoom sur une réaction, effet sonore sur un
     événement. Si l'on déplace une coupe, ils restent sur la bonne parole ou réaction ; si leur
     passage est coupé, ils disparaissent ;
   - à la **structure** (`anchor: 'edit'`) : titre d'ouverture, carton de fin, musique globale.
     Les transitions sont liées aux frontières entre segments.
4. **Conversions explicites et testées** :
   - `editToSource(t)` → un temps source, ou l'image figée pendant un arrêt sur image ;
   - `sourceToEdit(t)` → **une liste** de temps montage : vide si le passage est coupé, plusieurs
     valeurs si un passage est rejoué (_replay_) ;
   - `sourceRangeToEditRanges()` : une plage source peut se retrouver découpée en plusieurs morceaux.
5. **Le « temps média » d'un fichier de travail** (proxy, piste de clip) reste interne à
   `@acs/media` : `tempsMédia = tempsSource − début de la fenêtre`. Le projet de clip ne le
   connaît jamais. Seule la table `media_derivatives` stocke la fenêtre source.
6. Contrats de temps existants : métadonnées en secondes à l'import ; la transcription (étape 3)
   produira directement du `SourceMs`.

### 10.3 Ajout de l'éditeur et de la mémoire sans reconstruire l'import et le traitement

**Verdict : satisfait pour l'essentiel, sous réserve des corrections 10.1 et de celle ci-dessous.**

| Brique                                                                        | Réutilisable telle quelle ?                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Import par référence, empreinte, contrôle de l'original                       | ✅                                                                          |
| Lecture des métadonnées (ffprobe), gestion des MKV corrompus ou non finalisés | ✅                                                                          |
| Rôles des pistes                                                              | ✅                                                                          |
| Garde-fou d'écriture (jamais sur l'original, seulement dans `processing/`)    | ✅                                                                          |
| Lancement des processus sans shell, annulation, fichiers `.part`              | ✅                                                                          |
| Migrations SQLite                                                             | ✅ (ajouts de tables sans toucher aux données existantes)                   |
| File de traitements : types de travaux extensibles                            | ✅                                                                          |
| File de traitements : **unicité par (enregistrement, type)**                  | ❌ empêcherait de préparer les proxies de deux clips du même enregistrement |
| Stockage des fichiers dérivés                                                 | ❌ voir 10.1                                                                |

Correction supplémentaire : ajouter aux travaux des **paramètres** (`params_json`) et une
**clé de cible** (`target_key`, par exemple `recording:<id>:transcription` ou
`clip:<id>:proxy`), sur laquelle porte l'unicité. Le type `extract_audio` est renommé
`extract_transcription_audio`.

Ces trois corrections (dérivés, profils d'extraction, clé de cible des travaux) relèvent de
l'étape 2. Elles touchent uniquement `@acs/media`, la base et la file de traitements. Elles
représentent peu de code, sont couvertes par les tests existants et ne demandent aucune
reconstruction. Il vaut mieux les faire **maintenant**, avant que de vrais enregistrements soient en base.
