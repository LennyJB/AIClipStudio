# Guide : préparer et exporter un clip (étape 6)

Ce guide décrit l'interface « Clips » (étape 6c). Les mêmes opérations existent en ligne de
commande (`npm run render`, voir le README). Plan et règles : [`plan-etape-6.md`](plan-etape-6.md).

Aucune publication automatique : un export s'arrête au fichier dans `storage/exports/`.
L'original n'est jamais modifié.

## 1. Où se trouve la section « Clips »

Choisissez un enregistrement : la section **Clips** apparaît sous **Revue des propositions**.
Elle liste :

- les propositions **acceptées** et leur projet de clip (bouton « Créer le projet de clip » s'il
  n'existe pas encore) ;
- les projets dont la proposition n'est **plus acceptée** (refusée ou remise en attente), marqués
  « lecture seule » : rien n'y est modifiable, mais les rendus déjà produits restent consultables ;
- l'état du dernier rendu de chaque projet.

## 2. Audio exporté (une fois par enregistrement)

Le bloc **Audio exporté** affiche, piste par piste, la décision calculée par le serveur
(exportable ou bloquée, et pourquoi). L'interface n'applique aucune règle elle-même.

- **Déclarations** (Micro, Jeu, Tout / Mix) : indiquez pour chaque voix « présente » ou
  « absente ». Aucun choix n'est coché par défaut et l'envoi est impossible tant que tout n'est
  pas choisi. Une composition non déclarée bloque la piste.
- **Accords** (voix Discord, chat vocal du jeu, autres voix de tiers) : chacun s'enregistre par
  une action explicite, avec une note facultative (« accord de A et B »), et se révoque à tout
  moment. L'historique reste affiché.
- **Tout / Mix** : un accord Discord seul ne la rend jamais exportable ; il faut aussi la
  déclaration de sa composition et un accord pour chaque catégorie présente. Si des pistes
  séparées sont exportables, elles sont utilisées à sa place (jamais les deux ensemble).

Le micro peut capter le retour des haut-parleurs : déclarez-le s'il contient des voix de tiers.

## 3. Le panneau d'un clip

Chaque réglage est enregistré par le serveur, qui le valide, dans une nouvelle révision.

| Section          | Ce qu'on peut faire                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Cadrage          | Disposition, position du recadrage, part de la facecam ; image fixe actualisée ou bouton « Actualiser »             |
| Zones masquées   | Ne plus masquer une zone seulement après « Je comprends le risque » ; avertissement permanent ensuite               |
| Audio            | Retirer une piste ; ajouter ou réactiver une piste **autorisée par le serveur** ; gain ; −14 LUFS ; export sans son |
| Sous-titres      | Activation, sources (Discord grisé tant qu'il n'est pas autorisé), style, corrections ligne par ligne               |
| Effets           | « Proposer des effets » à la demande : ils arrivent désactivés, à activer un par un                                 |
| Durée            | Décalage du début et de la fin (±10 s), alertes ; « Confirmer la durée hors plage »                                 |
| Aperçu et export | Aperçu basse définition, export 1080×1920, progression, annulation, lecteur, vidéo et `.srt`                        |

Points importants :

- **Ajout de piste** : le bouton « Ajouter » n'apparaît que pour une piste que le serveur
  autorise. Le serveur revérifie au moment de l'enregistrement ; si l'accord a été retiré
  entre-temps (autre onglet, CLI), la modification est refusée et le message s'affiche.
- **Effets** : rien n'est proposé ni activé sans votre demande. Une nouvelle proposition ne
  modifie jamais l'état (activé ou désactivé) des effets déjà présents. Les idées de Claude sont
  affichées en texte seulement.
- **Corrections** : le texte d'origine reste consultable ; une correction s'annule.

## 4. Enregistrement des réglages

- Les modifications partent **une par une**, chacune sur la dernière version confirmée.
- **Erreur réseau** : « Réessayer » renvoie la même demande (aucun doublon possible).
- **Projet modifié ailleurs** : un bandeau liste vos modifications non enregistrées.
  « Recharger » récupère la version du serveur sans les effacer, puis « Réappliquer mes
  modifications » les renvoie. Rien n'est jamais écrasé automatiquement.
- **Refus du serveur** (accord manquant, durée…) : la modification n'est pas appliquée ; elle
  reste listée avec le message, jusqu'à « Réessayer » ou « Abandonner ».

## 5. Image fixe

L'image fixe montre la disposition avec les masques, sans rendu vidéo. Elle se régénère après un
changement de cadrage confirmé par le serveur, après un court délai d'inactivité, ou par le bouton
« Actualiser ».

- Dans le navigateur, une nouvelle demande abandonne la précédente, et une réponse arrivée trop
  tard est toujours ignorée.
- Sur le serveur, FFmpeg est arrêté si le navigateur abandonne la demande ou si une demande plus
  récente arrive pour le même clip. Au plus deux images sont générées en même temps ; au-delà,
  le message « Génération d'image déjà en cours » invite à réessayer.
- L'arrêt de FFmpeg n'est pas instantané : un processus remplacé peut finir son travail pendant
  un court instant.
