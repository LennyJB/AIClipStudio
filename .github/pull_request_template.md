## Résumé

<!-- En quelques phrases : ce que fait cette PR et pourquoi. Une PR = une fonctionnalité ou une étape. -->

## Fonctionnalités ajoutées

-

## Fichiers et composants importants modifiés

| Fichier / composant | Changement |
| ------------------- | ---------- |
|                     |            |

## Changements de base de données

<!-- Nouvelle migration ? Tables / colonnes ? Reprise de données ? Sinon : « Aucun ». -->

- Migration :
- Impact sur les données existantes :

## Tests réalisés et résultats

<!-- Uniquement des tests RÉELLEMENT exécutés, avec leurs résultats. -->

| Vérification                 | Commande                             | Résultat |
| ---------------------------- | ------------------------------------ | -------- |
| Types                        | `npm run typecheck`                  |          |
| Lint et formatage            | `npm run lint`, `format:check`       |          |
| Tests unitaires              | `npm run test:unit`                  |          |
| Tests d'intégration (FFmpeg) | `npm run test:integration`           |          |
| Migrations                   | `npm run test:migrations`            |          |
| Build et démarrage           | `npm run build:web`, `npm run smoke` |          |
| Essais manuels               |                                      |          |

## Points de vigilance

<!-- Limites connues, risques, éléments non testés, décisions à prendre. -->

-

## Checklist de validation

- [ ] La branche part de `main` et suit la convention de nommage
- [ ] Une seule fonctionnalité / étape dans cette PR
- [ ] `npm run check` passe en local
- [ ] La CI est entièrement verte (y compris Windows)
- [ ] Aucun secret, aucun enregistrement ni fichier `.env` dans les modifications
- [ ] Les enregistrements originaux ne sont jamais modifiés
- [ ] Migrations : nouvelle migration (jamais de modification d'une migration publiée) et verrou mis à jour
- [ ] Documentation (README, `docs/`, `.env.example`) à jour
- [ ] Points de vigilance listés ci-dessus
