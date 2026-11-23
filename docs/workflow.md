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

| Job                  | Vérifie                                                        | Équivalent local                            |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Qualité              | Types, lint, formatage                                         | `npm run typecheck`, `lint`, `format:check` |
| Tests unitaires      | Code pur, SQLite en mémoire                                    | `npm run test:unit`                         |
| Migrations           | Base neuve, reprise de données, migrations publiées inchangées | `npm run test:migrations`                   |
| Tests d'intégration  | FFmpeg réel, API complète ; **échoue si FFmpeg est absent**    | `npm run test:integration`                  |
| Build et démarrage   | Build de l'interface, démarrage réel de l'API                  | `npm run build:web`, `npm run smoke`        |
| Windows              | Tests et démarrage sous Windows (PR et `main`)                 | —                                           |
| Recherche de secrets | Tout l'historique Git (gitleaks)                               | —                                           |

Prévu : job Python (worker Faster-Whisper, sur CPU) à l'étape 3.

## Secrets et variables d'environnement

- Aucun secret dans le dépôt. `.env` est ignoré par Git ; `.env.example` documente chaque variable
  (vérifié par un test) sans aucune valeur sensible.
- La CI **n'a besoin d'aucun secret** et n'appelle jamais Claude API : les tests utilisent des
  réponses simulées.
- Si une évaluation réelle avec Claude est ajoutée (étape 6) : workflow lancé **manuellement**,
  clé stockée en _secret_ GitHub dans un _environnement_ protégé exigeant l'approbation du
  créateur, jamais exposée aux PR venant de forks.

## Réglages GitHub recommandés (à faire par le propriétaire du dépôt)

1. **Settings → General → Default branch** : `main`.
2. **Settings → General → Pull Requests** : autoriser uniquement _Allow squash merging_ ;
   cocher _Automatically delete head branches_.
3. **Settings → Rules → Rulesets → New branch ruleset**, cible `main`, statut _Active_ :
   - _Restrict deletions_, _Block force pushes_, _Require linear history_ ;
   - _Require a pull request before merging_ — **0 approbation requise** : les PR sont ouvertes
     depuis le compte du propriétaire, et GitHub interdit d'approuver sa propre PR. La fusion
     manuelle par le propriétaire constitue la validation ;
   - _Require status checks to pass_ : ajouter les jobs de la CI (ils apparaissent après une
     première exécution) — Qualité, Tests unitaires, Migrations, Tests d'intégration, Build et
     démarrage, Windows, Recherche de secrets.
4. **Settings → Code security** : activer _Secret scanning_ et _Push protection_.
