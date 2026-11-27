# Compte rendu de l'étape 7 : éditeur vidéo avec timeline

Plan : [`plan-etape-7.md`](plan-etape-7.md) (version 4, décisions § 1, précisions § 14 à 19).
Guide utilisateur : [`editeur.md`](editeur.md).

## Livré

| PR            | Contenu                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7a (#18)      | Projet de clip v2, opérations typées et inverses, invariants, historique, réapplication symétrique, scène partagée                                                                |
| 7b (#19)      | Journal d'édition en ajout seul (migration 8), points de contrôle, annuler / rétablir côté serveur, conflits                                                                      |
| 7c (#20)      | Moteur FFmpeg multi-segments (coupes, arrêts sur image, vides), fenêtre éditable ±60 s avec nouveau manifeste d'intégrité                                                         |
| 7d (#21)      | Médias de travail (proxy non masqué protégé, vignettes masquées, pistes autorisées), baux (migration 9)                                                                           |
| 7e (#22)      | Éditeur web complet : timeline, sous-titres, cadrage libre, masques temporels, effets visuels et sonores, calques texte ; aperçu canvas, Web Audio, fail-closed des autorisations |
| 7f (cette PR) | Bibliothèque de médias (migration 10), calques image et mèmes, effets sonores, parité aperçu / export mesurée, performances, guide                                                |

## Garanties tenues

- Original jamais modifié ; migrations publiées jamais modifiées (verrou) ; aucun appel à Claude
  dans le rendu ni les tests.
- `SourceMs` et `EditMs` jamais mélangés : tout passage de l'un à l'autre passe par les segments.
- Masques toujours opaques, posés sur l'image source avant tout le reste (aperçu, vignettes,
  image exacte, export) ; ni le flou créatif ni un calque ne peuvent les contourner.
- Audio : seules les pistes autorisées par le serveur sont chargées, lues et exportées ; une
  vérification impossible coupe tout le son (effets sonores compris).
- Aucun élément du document ignoré en silence : refus explicite (média manquant, fonction non
  rendue, piste non autorisée).

## Mesures

- Parité aperçu / image exacte FFmpeg : 0 px d'écart sur le rectangle d'un calque image
  (tolérance 2 px), couleur identique.
- Clip de 60 s, 50 segments, 50 calques, 100 sons : plan de rendu ≈ 2 ms, scène ≈ 0,1 ms par image.
- Rendu FFmpeg réel (aperçu) de 50 segments avec 10 calques et 20 sons : ≈ 5 s.

## Limites connues (acceptées, documentées)

- Texte : canvas contre libass, quelques pixels d'écart ; « Image exacte » fait foi.
- Normalisation `loudnorm` absente de l'aperçu (export seulement) ; bords du flou créatif.
- Lecture arrière (`J`) : recule d'une seconde, sans son.
- GIF animés et musique longue : hors périmètre de l'étape 7 (décisions 4 et 8).
- Vidéos Twitch / piste unique : prises en charge telles quelles ; parcours d'import dédié à
  l'étape 8 (§ 11).
