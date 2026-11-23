# Proposition : éditeur vidéo manuel et mémoire éditoriale

> **Statut : proposition en attente de validation.** Aucune implémentation n'est commencée.
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

- **Temps en millisecondes entières**, rapportés à la timeline de l'enregistrement original
  (aucune dérive de virgule flottante, indépendance vis-à-vis des proxies).
- **Coordonnées normalisées (0 à 1)** pour le recadrage et le placement : indépendantes de la
  résolution source (1080p, 1440p) et de la sortie.
- **`schemaVersion` + migrations** : un projet créé aujourd'hui restera ouvrable après évolution
  du format.
- **Identifiants stables** pour chaque élément (nécessaires à l'historique et à l'apprentissage).

Esquisse (non définitive) :

```ts
ClipProject {
  schemaVersion: 1
  id, recordingId, proposalId?, gameId, mode: 'fidele' | 'enrichi'
  output: { width: 1080, height: 1920, fps: 60 }
  segments: [{ id, srcStartMs, srcEndMs }]          // coupes dans l'original (début/fin modifiables)
  layout: [{ id, atMs, durMs, layers: [              // facecam + gameplay, éventuellement animés
    { role: 'gameplay' | 'facecam', crop: Rect, frame: Rect, radius?, border? } ] }]
  captions: [{ id, atMs, durMs, text, words?: [{ text, atMs, durMs }],
               style: { preset, color, size, position, highlightColor? } }]
  effects: [{ id, type: 'zoom' | 'freeze' | 'shake' | …, atMs, durMs, params }]   // params validés par type
  overlays: [{ id, type: 'image' | 'meme' | 'text', assetId?, atMs, durMs, frame: Rect, anim? }]
  transitions: [{ id, type, atSegmentBoundary, durMs, params }]
  audio: {
    tracks: [{ role: 'mic' | 'discord' | 'game' | 'mix', gainDb, muted }]
    sfx: [{ id, assetId, atMs, gainDb }]
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

| Étape | Contenu                 | Changement                                                                                                                   |
| ----- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1     | Initialisation          | ✅ terminée                                                                                                                  |
| 2     | Import et audio         | ✅ terminée (+ ajout ultérieur des proxies, à l'étape 7)                                                                     |
| 3     | Transcription           | inchangée                                                                                                                    |
| 4     | Analyse éditoriale      | + propositions stockées dans un format convertible en projet de clip ; + `analysis_runs`                                     |
| 5     | Interface de validation | + **raisons de refus**, + enregistrement des événements (mémoire v1 : capture)                                               |
| 6     | Évaluation              | + **mémoire v1** : préférences manuelles, statistiques de sélection, injection dans le prompt, mesure de l'effet             |
| 7     | Moteur de montage       | `timeline` + `render` : schéma du projet, composition Remotion, aperçu en lecture seule, export 9:16 en mode fidèle, proxies |
| 8     | Éditeur v1              | timeline multipiste, début/fin, sous-titres, facecam/gameplay, volumes, historique et annulation                             |
| 9     | Éditeur v2              | zooms, effets, transitions, images, memes, effets sonores, bibliothèque de ressources                                        |
| 10    | Mémoire v2              | apprentissage à partir des corrections du montage (opérations → statistiques → suggestions de préférences)                   |

## 6. Choix techniques supplémentaires envisagés

| Besoin                | Proposition                                                                                  | Justification                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aperçu et export      | **Remotion** (`@remotion/player`, `@remotion/renderer`)                                      | Déjà imposé par le cahier des charges ; même code pour l'aperçu et l'export. **Licence** : gratuite pour les particuliers et les petites structures selon les conditions publiées par Remotion, **à vérifier** avant l'étape 7. |
| État de l'éditeur     | **Zustand + Immer**                                                                          | Léger, et Immer produit nativement les correctifs nécessaires à l'historique.                                                                                                                                                   |
| Composant de timeline | Composant maison sur une base simple, ou bibliothèque existante                              | Décision à prendre à l'étape 8, après prototype.                                                                                                                                                                                |
| Formes d'onde         | Pics calculés par FFmpeg, stockés en JSON                                                    | Affichage instantané, même pour un clip long.                                                                                                                                                                                   |
| Mémoire               | SQLite + code déterministe ; Claude seulement pour résumer des commentaires en _suggestions_ | Transparence, coût maîtrisé, aucune décision silencieuse.                                                                                                                                                                       |

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

## 9. Décisions attendues

1. Validez-vous l'architecture (projet de clip comme source unique, nouveaux packages
   `timeline` / `render` / `memory`) ?
2. Validez-vous la feuille de route révisée (éditeur aux étapes 7 à 9, capture des retours dès l'étape 5) ?
3. Préférences déduites : **validation obligatoire** avant activation (recommandé) ou activation automatique ?
4. Ajouterez-vous une **4e piste OBS « Jeu »** (sans voix) pour le réglage des volumes ?
5. Faut-il versionner le cahier des charges et le plan technique dans `docs/` (en Markdown) ?
