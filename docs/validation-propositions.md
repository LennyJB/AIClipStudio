# Validation des propositions et mémoire éditoriale v1 (étape 5)

L'étape 5 permet d'examiner les propositions produites par l'analyse avec Claude (étape 4b),
de les accepter ou de les refuser avec des motifs, et d'enregistrer chaque décision dans un
**journal éditorial** exploitable à l'étape 6.

- **Rien n'est envoyé à Claude** à cette étape.
- **Aucun modèle n'est entraîné.**
- **Aucune préférence n'est déduite ni activée** : les décisions sont seulement enregistrées.

## 1. Utilisation

**Interface.** Le panneau « Revue des propositions » se trouve sous le panneau d'analyse.

- Par défaut, il affiche la dernière analyse terminée ; le sélecteur « Analyse » permet d'en
  choisir une autre.
- Deux onglets séparent les **clips proposés** et les **moments secondaires**.
- Les filtres : _À examiner_ (par défaut), _Acceptées_, _Refusées_, _Déjà examinées_, _Toutes_.

**Le détail d'une proposition** affiche :

- les horodatages en temps source, la durée, la pertinence et la fiabilité (deux indicateurs
  distincts), les catégories et les alertes ;
- l'explication, l'incertitude, les motifs de fiabilité et les preuves (citations vérifiées
  ou non) ;
- la transcription autour du passage, avec la mise en place, la chute et la fin de la réaction
  repérées, et les pistes **non transmises à Claude** signalées ;
- l'écoute de la piste « tout » sur le passage, plus 1,5 s de chaque côté, avec des marqueurs
  cliquables ;
- la **décision actuelle**, puis l'**historique**, dans deux sections séparées.

**Raccourcis clavier :** J et K pour la proposition suivante ou précédente, A pour accepter,
R pour refuser.

**CLI :**

```bash
npm run review -- <recordingId> [--run <id>] [--tier clip|secondary] [--status to_review|accepted|rejected|already_reviewed|all]
npm run review -- --show <proposalId>
npm run review -- --accept <proposalId> [--comment "…"] [--reevaluate]
npm run review -- --reject <proposalId> --reason chute_coupee [--reason trop_long] [--comment "…"] [--reevaluate]
npm run review -- --reset <proposalId>
npm run review -- --detach <proposalId> [--comment "…"]
npm run review -- --export [--game valorant]
```

## 2. Décisions

| Action              | Règle                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Accepter            | Commentaire facultatif, aucun motif                                                                                          |
| Refuser             | **Au moins un motif**, plusieurs possibles ; commentaire facultatif, **obligatoire avec `autre`**                            |
| Annuler la décision | Le passage redevient « à examiner » ; aucun motif, commentaire ni date ne reste dans la décision actuelle (la base l'impose) |
| Changer d'avis      | Une nouvelle décision remplace l'ancienne ; l'historique garde tout                                                          |

Motifs de refus : `pas_drole`, `manque_de_contexte`, `chute_coupee`, `trop_long`, `trop_court`,
`deja_vu`, `gameplay_sans_interet`, `audio_inaudible`, `contenu_a_eviter`, `autre`.

## 3. Le même moment d'une analyse à l'autre

Une nouvelle analyse (`--force`) produit de nouvelles propositions pour des passages souvent
déjà jugés. Pour ne pas les examiner deux fois, les propositions d'un même enregistrement sont
regroupées en **moments**.

- **Rapprochement** : deux propositions désignent le même passage si elles ont la même phrase de
  chute, ou si leurs chutes sont à 2 s au plus **et** que leurs plages se recouvrent sur au moins
  50 % de la plus courte.
- **Pas d'effet de chaîne** : une proposition n'est comparée qu'à la **référence figée** de chaque
  moment (copie de sa proposition fondatrice), jamais à ses autres membres.
- **Déterminisme** : pour un même ordre de traitement (date de création, puis identifiant), le
  regroupement est toujours le même. Un ordre différent peut légitimement donner d'autres
  regroupements.
- **Stabilité** : seules les nouvelles propositions sont affectées. Une appartenance existante
  n'est jamais modifiée, ce que la base garantit par un déclencheur. La seule modification
  possible est le **détachement** explicite d'une proposition, qui fonde alors un nouveau moment
  et est tracé dans `moment_changes`.
- **Décision héritée** : une proposition dont le moment a déjà une décision est « Déjà
  examinée ». Elle ne crée **aucun** événement. L'interface montre d'où vient la décision et
  propose _Ouvrir la proposition source_.
- **Réévaluation** : changer d'avis depuis une autre proposition du moment exige l'action
  explicite _Réévaluer_ (`reevaluate: true`). Sinon, l'API répond 409 `ALREADY_REVIEWED`.
- **Annulation** : seule la proposition qui porte la décision actuelle peut l'annuler. Ailleurs,
  l'API répond 409 `DECISION_ELSEWHERE`.

**Décision effective d'un moment :** c'est le **dernier événement** du moment, quel que soit son
type. Une annulation remet tout le moment « à examiner ». On ne revient **jamais** à une décision
plus ancienne d'un autre membre.

## 4. Idempotence et concurrence

- **Identifiant de demande** : chaque action porte un `requestId`, conservé lors des nouveaux
  essais.
  - Rejouée avec le même contenu, une demande renvoie **la réponse d'origine**, même si l'état a
    changé depuis. Cela vaut aussi pour une demande sans effet (`noop`), enregistrée sans
    événement éditorial.
  - Le même `requestId` avec un autre contenu est refusé : 409 `IDEMPOTENCY_MISMATCH`.
  - Les refus (400, 409) ne sont pas enregistrés.
- **Concurrence** : `expectedVersion` protège contre deux onglets ouverts. Si la version est
  périmée, l'API répond 409 `VERSION_CONFLICT` avec l'état actuel.

## 5. Données (migration 6)

| Table              | Rôle                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposal_reviews` | **Source de vérité** : décision propre à chaque proposition                                                                                                                                                      |
| `feedback_events`  | Journal éditorial, en **ajout seul** (déclencheurs) et **autonome** (pas de clé étrangère ; copie de la proposition : niveau, catégories, scores, bornes, versions des prompts et des modèles, `memory_version`) |
| `review_moments`   | Moments et leur référence figée (mêmes types que `clip_proposals`, vérifiés par un test)                                                                                                                         |
| `moment_members`   | Appartenance d'une proposition à un moment, jamais modifiée                                                                                                                                                      |
| `moment_changes`   | Détachements explicites (journal technique, en ajout seul)                                                                                                                                                       |
| `review_requests`  | Demandes traitées et réponse d'origine (idempotence ; en ajout seul)                                                                                                                                             |

La colonne `clip_proposals.review_status` (migration 5) n'est **plus jamais lue ni exposée**. Un
test d'architecture l'interdit dans le code, et un test « canari » vérifie qu'aucune réponse n'en
dépend.

**Pour l'étape 6.** Les statistiques doivent compter **une décision par moment** :
`effectiveDecisions(journal, appartenances)` de `@acs/memory`, fournie par l'export
(`npm run review -- --export`, lignes `event`, `membership`, `moment_change` et
`moment_decision`).

## 6. Écoute du passage

- **Extraction** : profil `preview` (WAV PCM 16 bits, mono, 48 kHz), même commande FFmpeg et même
  alignement que les autres extractions.
  - Piste « tout » (rôle `mix`) uniquement, sans repli vers une autre piste.
  - Fenêtre : le passage plus 1,5 s de chaque côté, plafonnée à 180 s.
  - Même cache, même file de traitements, fichiers `.part` ; l'original n'est jamais modifié.
- **Préparation** : `POST /api/proposals/:id/audio` renvoie 200 si l'extrait est prêt, 202
  pendant l'extraction.
- **Lecture** : `GET` (ou `HEAD`) `/api/proposals/:id/audio`, avec prise en charge de `Range` :

  | Requête                                          | Réponse                                       |
  | ------------------------------------------------ | --------------------------------------------- |
  | Sans `Range`                                     | 200                                           |
  | `bytes=a-b`, `bytes=a-` ou `bytes=-n`            | 206, avec `Content-Range` et `Content-Length` |
  | Plage hors du fichier                            | 416, avec `Content-Range: bytes */taille`     |
  | Plusieurs plages, syntaxe invalide ou `If-Range` | 200, fichier entier                           |

  Toujours `Accept-Ranges: bytes`.

- **Fichier servi** :
  - le chemin est lu en base, jamais fourni par le client ;
  - il doit être strictement dans `storage/processing/`, sans lien symbolique, et être un
    fichier `.wav` ordinaire ;
  - il est ouvert une seule fois.
- **Erreurs** : sans piste « tout », 409 `AUDIO_TRACK_MISSING`. Si le fichier a disparu,
  409 `NOT_READY`, puis une nouvelle préparation le recrée.

## 7. Tests

| Niveau                                 | Ce qui est vérifié                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@acs/memory`                          | Motifs, règles de saisie, machine d'états, rapprochement (seuils, symétrie), A-B-C dans plusieurs ordres, chaîne longue, déterminisme, décision effective (annulation sans résurrection, détachement)                                                                                |
| Service                                | Idempotence (y compris `noop` rejoué après un changement d'état), concurrence, héritage, réévaluation, annulations (scénarios A/B), détachement, stabilité des moments, cohérence base ↔ `effectiveDecisions` (test de propriété)                                                    |
| Migration 6                            | Reprise d'une base v5, types de la référence, déclencheurs, contraintes de la décision courante, journal qui survit à la suppression d'une analyse                                                                                                                                   |
| Intégration (FFmpeg réel, faux modèle) | Liste, contexte, décisions, rejeu, journal, héritage après `--force-recall`, **mêmes requêtes Claude après des décisions**, canari `review_status`, redémarrage, écoute (200/206/416, `HEAD`, original intact, cache, chemins falsifiés, lien symbolique, absence de piste « tout ») |
| Interface                              | Onglets, filtres, refus sans motif impossible, « Autre » avec commentaire, même `requestId` réessayé, 409, annulation, décision héritée, source, contexte, écoute                                                                                                                    |
| CLI                                    | Processus séparé sur une base temporaire, sans clé                                                                                                                                                                                                                                   |

## 8. Tests manuels différés (campagne finale)

Ces vérifications ne bloquent pas l'étape 5. Elles s'ajoutent à celles des étapes 4a et 4b.

| #   | Vérification                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------ |
| M1  | Parcours complet de la CLI `npm run review` sur un vrai enregistrement analysé                         |
| M2  | Interface : lisibilité, ergonomie, raccourcis, _Ouvrir la proposition source_, _Réévaluer_, _Détacher_ |
| M3  | Écoute dans le navigateur : son, déplacement dans l'extrait, marqueurs                                 |
| M4  | Enregistrement sans piste « tout » : message affiché                                                   |
| M5  | `--force` sur un vrai stream : propositions déjà examinées bien reconnues, sans faux rapprochement     |
| M6  | Ajustement éventuel des seuils (2 s, 50 %) et de la marge d'écoute (1,5 s)                             |
| M7  | Redémarrage du serveur sous Windows avec des décisions en base                                         |
| M8  | Relecture de l'export : données exploitables pour l'étape 6                                            |
