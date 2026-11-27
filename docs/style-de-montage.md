# Apprentissage du style de montage (étape 10)

Chaque créateur apprend à AI Clip Studio comment il veut que ses clips soient montés. L'application
apprend à partir de trois sources :

1. **Vidéos de référence déjà montées**, y compris celles d'autres créateurs.
2. **Paires brut + montage** : une vidéo brute et sa version montée, pour retrouver ce qui a été
   coupé.
3. **Vos décisions dans l'éditeur** : ce que vous changez dans vos propres montages.

Tout est fait **sur votre ordinateur**, avec FFmpeg et le document de montage. Aucune vidéo n'est
envoyée à un service externe et aucun appel payant n'est fait.

## Ce qui est appris, et ce qui ne l'est pas

Les capacités ont été vérifiées avant de choisir l'architecture. Il n'y a ni reconnaissance de
texte (OCR), ni OpenCV, ni reconnaissance de visage, de zoom, d'effet ou de musique. FFmpeg fournit
`scdet`, `blackdetect`, `freezedetect`, `loudnorm`, `silencedetect` et `astats`.

Le catalogue (`packages/style/src/catalog.ts`) indique, pour chaque caractéristique, quelles
sources peuvent **réellement** la mesurer. Une valeur prétendument « observée » par une source
incapable de la mesurer est ignorée, et refusée par le schéma.

| Caractéristique                                            | Vidéo montée                                    | Paire brut + montage | Vos montages (éditeur)      |
| ---------------------------------------------------------- | ----------------------------------------------- | -------------------- | --------------------------- |
| Coupes par minute, durée des plans                         | ✅ changements de plan visibles                 | ✅                   | ✅ segments exacts          |
| Coupes **éditoriales** (saut dans le brut)                 | ❌                                              | ✅ alignement sonore | ✅                          |
| Part du brut conservée                                     | ❌                                              | ✅                   | ✅                          |
| Durée du montage, format vertical                          | ✅                                              | ✅                   | durée ✅                    |
| Fondus au noir                                             | ✅ (pas les fondus enchaînés ni les animations) | ✅                   | ❌ (absents de l'éditeur)   |
| Arrêts sur image                                           | ✅                                              | ✅                   | ✅                          |
| Sonie intégrée, plage de sonie, part de silence            | ✅                                              | ✅                   | sonie (normalisation) ✅    |
| Sous-titres (police, taille, couleurs, position, karaoké…) | ❌ pas d'OCR                                    | ❌                   | ✅ réglages exacts          |
| Disposition et facecam                                     | ❌ pas de détection de visage                   | ❌                   | ✅                          |
| Zooms (fréquence, intensité)                               | ❌                                              | ❌                   | ✅                          |
| Effets visuels, effets sonores, images ajoutées            | ❌                                              | ❌                   | ✅                          |
| Musique de fond                                            | ❌                                              | ❌                   | ❌ réglage manuel seulement |
| Densité générale                                           | indice dérivé de ce qui est mesuré              | idem                 | idem                        |

Une caractéristique non mesurable est affichée comme telle dans l'interface, avec son
explication. Vous pouvez toujours la régler à la main.

**Contenu des références :**

- jamais de transcription, d'image ni de son conservés ;
- seulement des grandeurs agrégées : comptes par minute, durées médianes, sonie, parts.

On apprend un style, jamais le contenu, les dialogues ou les événements d'une vidéo.

## Paire brut + montage : comment l'alignement fonctionne

1. Les plans de la version montée sont détectés par leurs changements d'image.
2. Une **enveloppe sonore** à 20 Hz (niveau RMS par fenêtre de 50 ms) est extraite des deux
   vidéos.
3. Chaque plan est recherché dans le brut par corrélation normalisée. La recherche se fait
   d'abord après le plan précédent, puis dans tout le brut.

Un plan est aligné si sa corrélation est d'au moins **0,85**. Un plan muet ou trop court, ou un
plan sans correspondance nette, n'est **pas** aligné. Si moins de la moitié des plans sont
alignés, aucune structure n'est déduite et la limite est affichée.

À partir de l'alignement, on distingue :

- les **coupes éditoriales** : un saut ou un retour en arrière dans le brut ;
- les **raccords continus** : la scène filmée change, mais le montage ne coupe pas.

On calcule aussi la **part du brut conservée**.

**Limites de l'alignement :**

- une musique ajoutée par-dessus la voix, ou un son très retravaillé, fait échouer l'alignement :
  la paire est alors traitée comme une simple référence ;
- les changements de vitesse ne sont pas détectés ;
- un brut très long est entièrement décodé pour son son : comptez quelques minutes pour plusieurs
  heures de stream.

## Profils, brouillons et validation

- **Six profils sont fournis** : Gaming, Just Chatting, Réaction, Podcast / Discussion, IRL et
  Mixte. Mixte s'applique à tout format qui n'a pas de profil propre.
- **Profils personnalisés** : vous choisissez leur nom et les formats auxquels ils s'appliquent.
  Ils peuvent être archivés. Ceux qui n'ont aucun format ne sont jamais appliqués
  automatiquement.
- **Associer une référence à un profil** : c'est fait à l'import ou plus tard. Seules les
  références associées et analysées servent à apprendre ce profil.

**Fonctionnement des versions :**

- **Apprendre** crée un nouveau **brouillon**. Les valeurs sont agrégées (médiane et dispersion
  pour les nombres, majorité pour les choix) à partir des références associées et des projets du
  même format que vous avez modifiés dans l'éditeur.
- **Une valeur réglée à la main n'est jamais remplacée** par l'apprentissage.
- Toute modification crée une **nouvelle version**. Les versions et les validations sont en ajout
  seul (migration 12) : **une version validée n'est jamais modifiée**.
- **Valider** porte sur une version précise. L'empreinte des valeurs affichées est vérifiée : vous
  validez exactement ce que vous avez vu. **Seule une version validée est utilisée.** Un brouillon
  ne change rien tant qu'il n'est pas validé.
- Les changements du brouillon par rapport à la version validée sont surlignés.

## Application aux nouveaux clips, selon le passage

À la création d'un projet de clip :

1. On détermine le **type de contenu de l'extrait** : type majoritaire sur ses bornes, d'après la
   segmentation de l'étape 9 (jamais une détection obsolète). Sans segmentation, l'extrait est
   considéré comme du gaming, l'hypothèse historique.
2. On choisit le **profil validé** de ce format, sinon le profil Mixte. Si plusieurs profils
   conviennent, le plus récemment validé l'emporte.

Un même stream peut donc produire des clips Gaming et des clips Just Chatting, avec des styles
différents.

**Ce qui est appliqué**, uniquement ce que le document sait représenter :

- le style des sous-titres et leur affichage ;
- la disposition. La facecam n'est appliquée que si un cadrage avec facecam est validé ;
- la hauteur de la facecam ;
- le mode de montage. L'indication de la proposition elle-même reste prioritaire ;
- la normalisation de la sonie.

Le rythme, les zooms et les effets restent des **repères** enregistrés avec le projet
(`GET /api/clip-projects/:id/style`) : **aucune coupe ni aucun effet n'est inventé** dans le
montage.

L'application est tracée : profil, version, format de l'extrait et valeurs appliquées. **Sans
profil validé**, un projet est créé exactement comme avant l'étape 10.

Les règles de consentement ne changent pas. Le style ne peut pas activer des sous-titres sans
piste autorisée, et ne touche jamais aux règles d'export audio.

## API

| Méthode              | Route                               | Rôle                                                                          |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| GET                  | `/api/style/catalog`                | Caractéristiques, groupes, sources capables de les mesurer, limites           |
| GET / POST           | `/api/style-profiles`               | Liste ; création d'un profil personnalisé `{ name, contentTypes }`            |
| GET / PATCH          | `/api/style-profiles/:id`           | Détail (versions validée et brouillon, changements) ; nom, formats, archivage |
| POST                 | `/api/style-profiles/:id/learn`     | Apprend un brouillon `{ requestId }`                                          |
| PUT                  | `/api/style-profiles/:id/draft`     | Réglages manuels `{ requestId, baseVersion, set, clear }`                     |
| POST                 | `/api/style-profiles/:id/validate`  | Validation `{ requestId, version, featuresHash }`                             |
| GET / POST           | `/api/style-references`             | Liste ; import `{ kind: edited \| pair, path, rawPath?, profileId? }`         |
| GET / PATCH / DELETE | `/api/style-references/:id`         | Détail ; association à un profil ; retrait de la fiche (fichier intact)       |
| POST                 | `/api/style-references/:id/analyze` | Analyse locale (job `analyze_style_reference`, voie `heavy`)                  |
| GET                  | `/api/clip-projects/:id/style`      | Style appliqué à un projet (profil, version, valeurs, repères)                |

Les fichiers de référence sont **seulement référencés** : chemin et empreinte, jamais copiés ni
modifiés. Un fichier modifié depuis son import est refusé à l'analyse. L'API n'expose que le nom
du fichier, jamais son chemin.

## Seuils (prudents, non calibrés sur un grand corpus)

| Seuil                        | Valeur                                                        |
| ---------------------------- | ------------------------------------------------------------- |
| Changement de plan (`scdet`) | 12                                                            |
| Passage par le noir          | au moins 0,1 s, pixels sous 10 %                              |
| Image figée                  | au moins 0,4 s                                                |
| Silence                      | sous −40 dB pendant au moins 0,3 s                            |
| Alignement                   | corrélation d'au moins 0,85, variation sonore d'au moins 2 dB |

Votre correction reste la référence : réglez à la main ce qui ne vous convient pas.
