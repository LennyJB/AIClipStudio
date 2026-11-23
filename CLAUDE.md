# Instructions pour Claude Code — AI Clip Studio

Ces règles s'appliquent à **toutes** les étapes du projet, sans exception.
Détails : `docs/workflow.md`. Architecture : `docs/architecture.md`.

## Workflow Git et Pull Requests

1. **Ne jamais développer directement sur `main`.** Chaque étape ou fonctionnalité part d'une
   branche créée depuis `main` à jour :
   `feature/…`, `fix/…`, `refactor/…`, `test/…`, `docs/…`, `ci/…`, `chore/…` (kebab-case).
2. **Une PR = une fonctionnalité ou une étape.** Ne jamais mélanger des sujets indépendants.
3. **Commits réguliers et explicites**, au format `type(périmètre): message` en français
   (`feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `chore`).
4. **Avant de présenter une PR comme prête** :
   - `npm run check` passe en local (types, lint, format, tests, build, démarrage) ;
   - la branche est poussée et **la CI GitHub est entièrement verte** ;
   - si la CI échoue : analyser, corriger, repousser, puis seulement présenter la PR.
5. **Description de PR** : suivre `.github/pull_request_template.md` (résumé, fonctionnalités,
   fichiers importants, base de données, tests réellement exécutés et résultats, points de
   vigilance, checklist).
6. **Ne jamais fusionner une PR.** Le créateur valide et fusionne lui-même (Squash and merge).
7. **Ne jamais passer à l'étape suivante sans validation explicite du créateur.**
8. **Ne jamais affirmer qu'un test a réussi s'il n'a pas réellement été exécuté.**
9. **En cas de décision importante** : poser une question précise plutôt que supposer.

## Règles techniques permanentes

- Clés API côté serveur uniquement, dans `.env` (jamais versionné). La CI n'utilise aucun secret
  et n'appelle jamais Claude API (réponses simulées dans les tests).
- Les enregistrements originaux ne sont jamais modifiés ni supprimés.
- Une migration publiée n'est jamais modifiée : en ajouter une nouvelle et mettre à jour
  `services/api/src/migrations-lock.test.ts`.
- Toute nouvelle variable de configuration est documentée dans `.env.example` (vérifié par un test).
- Temps : `SourceMs` (original) et `EditMs` (montage) ne sont jamais mélangés.
- Aucune commande générée par l'IA n'est exécutée ; toute réponse de Claude est validée par un
  schéma strict.
