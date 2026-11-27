# Guide de l'éditeur vidéo (étape 7)

L'éditeur monte un clip vertical 9:16 à partir d'une proposition **acceptée** : coupes, arrêts sur
image, sous-titres, cadrage libre, zones masquées, effets, calques (texte, images, mèmes) et
effets sonores. L'aperçu est calculé dans le navigateur ; l'export est produit par FFmpeg, avec
les mêmes règles et la même géométrie. Plan et décisions : [`plan-etape-7.md`](plan-etape-7.md).

## Ouvrir l'éditeur

Dans « Clips », lien **Ouvrir l’éditeur** d'un projet (adresse `#/editeur/<projet>`). L'éditeur prépare
ses médias de travail (proxy vidéo, vignettes, pistes audio autorisées) ; la préparation est
signalée sous l'aperçu.

- Chaque geste est enregistré automatiquement (journal) ; « Enregistrer une version » crée un
  point de contrôle. Un brouillon local protège les gestes en cas de fermeture brutale.
- Plusieurs onglets peuvent être ouverts : les gestes de l'un apparaissent dans l'autre. Un
  conflit n'écrase jamais rien : l'éditeur propose de recharger puis de réappliquer.
- Annuler / Rétablir suivent l'historique du projet, même après un rechargement.

## Aperçu et image exacte

- L'aperçu (canvas 540 × 960) suit la même description de scène que l'export : mêmes coupes,
  mêmes zones masquées (aplats noirs posés avant tout le reste), même cadrage, mêmes effets,
  mêmes textes, mêmes calques.
- **Image exacte** : image FFmpeg de l'export au même instant. **Elle fait foi.**
- Écarts connus et acceptés : rendu du texte (navigateur contre libass, quelques pixels), bords
  du flou créatif, normalisation du volume absente de l'aperçu, `J` recule d'une seconde.
- Les calques image ont été mesurés au pixel près contre l'image exacte (écart mesuré : 0 px ;
  tolérance du test : 2 px).

## Son et autorisations

Seules les pistes **autorisées par le serveur** (accords et déclarations de l'audio exporté) et
activées sont chargées et lues. Une révocation est détectée en moins de 2 s : la lecture s'arrête
et la piste est retirée de la mémoire. Si les autorisations ne peuvent pas être vérifiées (API
injoignable), **tout le son est coupé** (pistes et effets sonores), les sous-titres des sources
audio sont masqués et un avertissement reste affiché jusqu'au rétablissement.

## Bibliothèque de médias (images, mèmes, effets sonores)

La bibliothèque se trouve sur la page d'accueil (« Bibliothèque de médias ») et dans le panneau
du projet de l'éditeur (« Image ou mème de la bibliothèque… », « Son de la bibliothèque… »).

### Importer

1. Choisissez un fichier : **images fixes** PNG, JPEG, WebP, GIF non animé ; **sons** WAV, MP3,
   OGG, FLAC, M4A (effets courts).
2. **Déclarez vos droits** (obligatoire) : création personnelle, sous licence, ou domaine public ;
   précisez au besoin la source ou la licence. N'importez que des médias que vous avez le droit
   d'utiliser.
3. « Importer ». Le serveur vérifie le fichier puis le **ré-encode** (PNG ou WAV 48 kHz) dans
   `storage/assets/`. Le fichier choisi sur votre disque n'est jamais modifié.

Refusés, avec la raison : SVG, HTML et tout format texte ; extension qui ne correspond pas au
contenu ; fichier « polyglotte » (données cachées après l'image) ; image animée (GIF animé,
APNG, WebP animé) ; image trop grande (4096 px par côté par défaut) ; son trop long (60 s par
défaut) ; fichier vide, tronqué ou trop volumineux (25 Mo par défaut). Limites réglables dans
`.env` (`MEDIA_ASSET_MAX_MB`, `MEDIA_ASSET_MAX_IMAGE_SIDE`, `MEDIA_ASSET_MAX_AUDIO_SEC`).

Le même fichier importé deux fois n'est stocké qu'une fois.

### Utiliser dans un clip

- **Image ou mème** : placé à la tête de lecture pour 2 s, cadre initial au rapport de l'image
  (40 % de la largeur). Réglages dans l'inspecteur : cadre (x, y, largeur, hauteur dans l'image
  9:16), opacité, ordre d'empilement, horaires sur la timeline. L'image est étirée à son cadre.
- **Effet sonore** : placé à la tête de lecture pour sa durée ; gain réglable. Un son que
  l'aperçu ne peut pas charger (fichier manquant, erreur du serveur, son illisible) est signalé
  sous l'aperçu, avec la cause ; il n'est jamais ignoré en silence. Il est mixé avec
  l'enregistrement, n'est ni atténué ni bipé par les effets `duck` et `bleep` (qui visent
  l'enregistrement), mais suit les fondus d'entrée et de sortie. Un export **sans son** n'a
  aucun effet sonore.
- Ancré au **contenu**, un élément suit les coupes ; ancré au **montage**, il reste à sa place.
  Un effet sonore ancré au contenu se tait pendant un arrêt sur image ou un vide, comme le son
  de l'enregistrement.

### Confidentialité

Les calques sont posés sur l'image **composée** : ils ne peuvent jamais découvrir une zone
masquée (les aplats sont posés avant, sur l'image source). Une partie transparente d'un calque
laisse voir l'aplat, jamais l'image d'origine.

### Fichier manquant

Si un fichier de la bibliothèque (ou son aperçu) disparaît ou est altéré sur le disque, même sans
changer de taille, il est signalé et n'est plus servi
(« Fichier manquant ») dans la bibliothèque, sur la timeline et dans l'aperçu (cadre hachuré).
Le rendu est alors **refusé** avec un message explicite : rien n'est ignoré en silence.
**Réimporter le même fichier le répare.**

### Supprimer

« Supprimer » est refusé tant qu'un projet utilise le média, même s'il en a été retiré (une
annulation pourrait le ramener) ou qu'un rendu est en cours. Un rendu déjà lancé utilise sa
propre copie vérifiée : supprimer ou modifier le fichier pendant le rendu est sans effet sur lui.

## Rendu et export

« Aperçu FFmpeg » et « Exporter » partent de la dernière version enregistrée. Avant chaque rendu,
le serveur revérifie : décision de revue, accords audio, durée, intégrité de l'original, fichiers
de la bibliothèque (empreinte). L'export est écrit dans `storage/exports/`.

## Dépannage

| Message                                       | Que faire                                                           |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Import refusé : extension trompeuse           | Renommez le fichier avec l'extension de son vrai format             |
| Import refusé : image animée                  | Exportez une seule image (PNG) ; les GIF animés viendront plus tard |
| Média utilisé par N projet(s)                 | Retirez-le des projets ; il reste lié à leur historique             |
| Média(s) de la bibliothèque manquant(s)       | Réimportez le même fichier, ou retirez le calque / l'effet sonore   |
| Vérification des autorisations indisponible   | Vérifiez que l'API tourne ; le son revient après une réponse valide |
| Le moteur de rendu ne prend pas en charge : … | Retirez l'élément indiqué (refus explicite, jamais ignoré)          |
