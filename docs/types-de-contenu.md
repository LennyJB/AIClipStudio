# Types de contenu et segmentation temporelle (étape 9)

AI Clip Studio ne suppose plus qu'un enregistrement est du gaming. Il reconnaît localement les
formats **Gaming**, **Just Chatting**, **Réaction**, **Podcast / Discussion** et **IRL**, découpe
l'enregistrement en **segments horodatés** et adapte le repérage des moments au format de chaque
passage. Un stream qui change de format est résumé **Mixte** : aucun type unique n'est imposé à
un enregistrement varié.

## Ce qui est détecté, et comment

La détection (`packages/editorial/src/content/detect.ts`) est une fonction pure, locale et
déterministe. Elle n'appelle ni Claude API ni aucun service externe. Elle combine trois familles
d'indices, observées par blocs de 60 s :

| Indice            | Source                                                                    | Ce qu'il permet                                             |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Transcription     | expressions caractéristiques (`profiles/content/*.json`), termes du jeu   | « merci pour le sub », « je mets pause », « notre invité »… |
| Structure audio   | part de parole du micro et de Discord, équilibre entre voix               | voix seule (Just Chatting) ou échange équilibré (podcast)   |
| Activité visuelle | différence moyenne entre images clés, mesurée par FFmpeg (`scdet`, 64×36) | image fixe (webcam, plateau) ou animée (jeu, vidéo, rue)    |

**Limites assumées :**

- **Aucune reconnaissance d'image.** L'activité visuelle distingue une image fixe d'une image
  qui bouge. Elle ne sait pas si l'image montre un jeu, une vidéo regardée ou une rue. Ces trois
  cas ne sont départagés que par la transcription. Sans mot caractéristique, la détection ne
  conclut pas.
- **La transcription seule ne suffit pas.** Une décision qui ne repose que sur la transcription
  est plafonnée à une confiance de **0,6**. Une décision corroborée par la structure audio ou
  l'image est plafonnée à **0,9**. Seule la correction du créateur vaut 1.
- **Piste unique « Tout ».** La répartition de la parole est inconnue et n'est jamais inventée.
- **Profil de jeu générique.** Les termes du jeu ne servent pas d'indice. Une partie en équipe
  sans image mesurée ressemble alors aussi à une discussion.
- **Précision des transitions.** Les changements de format sont situés à un bloc près (60 s).
- **Seuils prudents, non calibrés sur un grand corpus.** La correction reste la référence.

## Incertitude : ne pas conclure plutôt que se tromper

Un bloc reste **indéterminé** dans ces cas :

- le meilleur format obtient moins de 0,35 ;
- l'écart avec le second est inférieur à 0,1 ;
- il n'y a ni parole ni image mesurée.

Les formats envisagés restent visibles (« pistes : Réaction, IRL »).

Les blocs sont ensuite lissés en segments :

- une minute ambiguë isolée au milieu d'un même format prend ce format ;
- un passage bref et peu sûr devient indéterminé ;
- une vraie pause de quelques minutes est conservée.

**Résumé de l'enregistrement.** Un format est significatif s'il couvre au moins 10 % de la durée
et au moins 5 min (ou au moins 25 % d'un enregistrement court).

| Formats significatifs | Résumé         |
| --------------------- | -------------- |
| 2 ou plus             | **Mixte**      |
| 1                     | ce format      |
| aucun                 | **Non conclu** |

## Correction par le créateur

Le panneau **Types de contenu** de l'enregistrement permet de :

- voir chaque segment avec son type, sa confiance, ses indices et les limites de la détection ;
- changer un type, couper un segment à un instant, fusionner deux segments, puis enregistrer ;
- revenir à la détection automatique.

Règles :

- une correction est une segmentation **complète** : contiguë, sans trou ni chevauchement, du
  début à la fin ;
- elle **l'emporte toujours**, y compris sur une détection relancée ensuite ;
- détections et corrections sont journalisées en **ajout seul** (migration 11) : l'historique
  est conservé ;
- une correction est idempotente par `requestId`.

## Effet sur l'analyse éditoriale

L'analyse utilise la segmentation **effective** :

- la dernière correction, si elle existe ;
- sinon la dernière détection ;
- sinon aucune.

1. **Repérage local.** Chaque case de 5 s est notée avec la pondération du format de son
   passage (`localWeights` du profil). Un rire ou une interjection pèse plus en Just Chatting
   et en Réaction. Une question suivie d'une réponse pèse plus en podcast. Le volume reste
   plafonné à 0,25 : **un pic sonore seul ne crée jamais de fenêtre**, quel que soit le seuil.
2. **Requêtes à Claude.** Un bloc de contexte est ajouté au message de chaque tranche de repérage
   et de chaque fenêtre. Il donne :
   - les formats du passage et leur provenance (confirmé par le créateur, confiance
     automatique, ou format non établi) ;
   - les critères du format.

   Il est présenté comme un **contexte, jamais une preuve** : en cas de contradiction, la
   transcription prime. Les prompts système ne changent pas (cache intact).

3. **Clé d'entrée.** La segmentation fait partie de la clé de l'analyse. Une correction produit
   donc une nouvelle préparation.

**Gaming inchangé.** Un enregistrement sans segmentation, ou dont tous les passages sont gaming
ou indéterminés, est analysé **exactement** comme avant l'étape 9 :

- même pondération ;
- mêmes requêtes ;
- même clé : une préparation existante est réutilisée.

Le gaming reste la référence historique : son profil n'a pas de pondération propre.

**Confidentialité et consentement inchangés.** La détection lit la transcription déjà produite
et l'image de l'original, en lecture seule. Elle n'envoie rien et ne modifie pas les règles
d'export audio. Le texte Discord non autorisé n'est jamais transmis, quel que soit le format.

## API

| Méthode | Route                                      | Rôle                                                                  |
| ------- | ------------------------------------------ | --------------------------------------------------------------------- |
| GET     | `/api/recordings/:id/content-types`        | Détection, correction, segmentation effective et résumé               |
| POST    | `/api/recordings/:id/content-types/detect` | Détection (job `detect_content_types`, voie `analysis`) ; `force`     |
| PUT     | `/api/recordings/:id/content-types`        | Correction `{ requestId, segments }` ; `segments: null` = automatique |

La détection exige une transcription terminée (`ANALYSIS_NOT_READY` sinon). Une détection
identique (mêmes transcriptions, original, profils et version du détecteur) est réutilisée.

## Profils de contenu

`profiles/content/<type>.json` (schéma `ContentProfileSchema`, `packages/shared/src/content.ts`) :

- `context` et `analysisHints` : transmis comme contexte à l'analyse ;
- `detectionCues` : expressions caractéristiques, des indices de transcription seulement ;
- `localWeights` : pondération propre au format. La somme vaut 1 et le volume est plafonné à
  0,25. Elle est absente pour le gaming, qui garde la pondération historique.

Modifier un profil change l'empreinte des détections (« à relancer ») et celle des analyses
d'enregistrements non gaming.
