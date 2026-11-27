# Workflow de développement

## Branches

- **`main`** : branche de référence, toujours dans un état fonctionnel. Aucun développement direct.
- Une branche par étape ou fonctionnalité, créée depuis `main` à jour :

| Préfixe     | Usage                                   | Exemple                         |
| ----------- | --------------------------------------- | ------------------------------- |
| `feature/`  | Nouvelle fonctionnalité / étape         | `feature/transcription-whisper` |
| `fix/`      | Correction                              | `fix/duree-mkv-non-finalise`    |
| `refactor/` | Restructuration sans changement visible | `refactor/file-de-traitements`  |
| `test/`     | Ajout ou amélioration de tests          | `test/proprietes-timeline`      |
| `docs/`     | Documentation seule                     | `docs/cahier-des-charges`       |
| `ci/`       | Intégration continue                    | `ci/job-python`                 |
| `chore/`    | Maintenance, dépendances                | `chore/maj-dependances`         |

## Commits

Format `type(périmètre): message`, en français, un sujet par commit :
`feat(media): extraction d'une plage source`, `fix(api): …`, `test(timeline): …`.

## Cycle d'une étape

1. `git switch main && git pull` puis `git switch -c feature/nom-de-l-etape`.
2. Développer avec des commits réguliers.
3. Vérifier en local :

   ```bash
   npm run check
   ```

4. Pousser la branche : la CI s'exécute.
5. Ouvrir une Pull Request vers `main` (le modèle de description est prérempli).
6. La CI doit être **entièrement verte** avant de présenter la PR.
7. **Le créateur relit et fusionne** (« Squash and merge »). Rien n'est fusionné automatiquement.
8. L'étape suivante ne commence qu'après sa validation.

## CI (GitHub Actions)

Déclenchée à chaque Pull Request vers `main` et à chaque push sur `main` ou une branche
`feature/**`, `fix/**`, `refactor/**`, `test/**`, `docs/**`, `ci/**`, `chore/**`.

| Job                  | Vérifie                                                          | Équivalent local                            |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Qualité              | Types, lint, formatage                                           | `npm run typecheck`, `lint`, `format:check` |
| Tests unitaires      | Code pur, SQLite en mémoire, interface (jsdom)                   | `npm run test:unit`                         |
| Migrations           | Base neuve, reprise de données, migrations publiées inchangées   | `npm run test:migrations`                   |
| Tests d'intégration  | FFmpeg réel, API complète ; **échoue si FFmpeg est absent**      | `npm run test:integration`                  |
| Éditeur (Playwright) | Parcours de l'éditeur : API réelle, Vite, Chromium               | `npm run test:e2e`                          |
| Build et démarrage   | Build de l'interface, démarrage réel de l'API                    | `npm run build:web`, `npm run smoke`        |
| Windows              | Tests et démarrage sous Windows (PR et `main`)                   | —                                           |
| Worker Python        | pytest + vrai modèle `tiny` sur CPU + bout en bout Node ↔ worker | `pytest` (vrai modèle : CI uniquement)      |
| Recherche de secrets | Tout l'historique Git (gitleaks)                                 | —                                           |

Aucun runner GitHub n'a de GPU : la transcription GPU se vérifie sur la machine du créateur
(`npm run doctor -- --gpu`).

## Secrets et variables d'environnement

- Aucun secret dans le dépôt. `.env` est ignoré par Git ; `.env.example` documente chaque variable
  (vérifié par un test) sans aucune valeur sensible.
- La CI **n'a besoin d'aucun secret** et n'appelle jamais Claude API : les tests utilisent des
  réponses simulées.
- Si une évaluation réelle avec Claude est ajoutée (étape 6) : workflow lancé **manuellement**,
  clé stockée en _secret_ GitHub dans un _environnement_ protégé exigeant l'approbation du
  créateur, jamais exposée aux PR venant de forks.

## Réglages GitHub (à faire par le propriétaire du dépôt)

État constaté le 23/11/2026 : branche par défaut **`claude/funny-noether-63ljaj`** (à corriger),
`main` **non protégée** (aucune règle n'impose la CI avant fusion), PR #1 et #2 fusionnées par
_merge commit_.

### 1. Branche par défaut

**Settings → General → Default branch** → icône ⇄ → choisir `main` → _Update_ → confirmer.

Conséquences : les nouvelles PR ciblent `main` par défaut, et la page d'accueil du dépôt et le
badge CI montrent `main`. Ensuite seulement, les anciennes branches pourront être supprimées
(une branche par défaut ne peut pas l'être).

### 2. Squash and merge uniquement

**Settings → General → Pull Requests** :

- décocher _Allow merge commits_ ;
- cocher **_Allow squash merging_** (message par défaut : _Pull request title and description_) ;
- décocher _Allow rebase merging_ ;
- cocher **_Automatically delete head branches_** ;
- laisser _Allow auto-merge_ **décoché** (aucune fusion automatique).

### 3. CI obligatoire avant fusion (ruleset sur `main`)

**Settings → Rules → Rulesets → New ruleset → New branch ruleset** :

- _Ruleset name_ : `main` ; _Enforcement status_ : **Active** ;
- _Bypass list_ : **vide** (personne ne contourne, propriétaire compris) ;
- _Target branches_ → _Add target_ → **Include default branch** (une fois l'étape 1 faite),
  ou _Include by pattern_ → `main` ;
- cocher **Restrict deletions** et **Block force pushes** ;
- cocher **Require linear history** (cohérent avec Squash and merge) ;
- cocher **Require a pull request before merging**, avec _Required approvals_ = **0** : les PR
  sont ouvertes depuis le compte du propriétaire, et GitHub interdit d'approuver sa propre PR.
  C'est la fusion manuelle par le propriétaire qui vaut validation. _Allowed merge methods_ :
  **Squash** uniquement ;
- cocher **Require status checks to pass**, puis :
  - cocher **Require branches to be up to date before merging** : la CI doit avoir tourné sur la
    branche à jour de `main`, c'est-à-dire sur le code qui sera réellement fusionné ;
  - _Add checks_ : saisir **exactement** ces noms (ce sont les noms des jobs ; ils sont proposés
    dans la liste après une première exécution de la CI) :

    | Vérification obligatoire                            |
    | --------------------------------------------------- |
    | `Qualité (TypeScript, lint, format)`                |
    | `Tests unitaires`                                   |
    | `Migrations de base de données`                     |
    | `Tests d'intégration (FFmpeg)`                      |
    | `Build et démarrage de l'API`                       |
    | `Windows (tests et démarrage)`                      |
    | `Worker Python (pytest + vrai modèle tiny sur CPU)` |
    | `Recherche de secrets (gitleaks)`                   |

  - pour chacun, source : **GitHub Actions** ;
- _Create_.

Vérification : sur une PR dont un job est rouge ou en cours, le bouton de fusion doit être
bloqué (« Required statuses must pass »).

> Si un job est renommé dans `.github/workflows/ci.yml`, mettre à jour cette liste **et** le
> ruleset : un nom obsolète bloque toutes les fusions (vérification attendue qui n'arrive jamais).

### 4. Sécurité

**Settings → Code security** : activer **Secret scanning** et **Push protection** (gratuits pour
un dépôt public).

### 5. Nettoyage (après l'étape 1)

Les branches `claude/funny-noether-63ljaj`, `feature/etapes-1-2-import-audio` et
`fix/installation-windows-sqlite` sont déjà fusionnées ou obsolètes et peuvent être supprimées
(**Code → Branches**). Avec _Automatically delete head branches_, les suivantes le seront
automatiquement.
