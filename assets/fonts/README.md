# Polices des sous-titres

Polices fournies avec le projet pour que le rendu des sous-titres soit identique sur toutes les
machines (Linux, Windows, CI), sans dépendre des polices installées. Toutes deux sont sous licence
**SIL Open Font License 1.1** (texte complet joint), qui autorise leur redistribution avec un
logiciel.

| Fichier                    | Police                          | Source                                                      | Licence              |
| -------------------------- | ------------------------------- | ----------------------------------------------------------- | -------------------- |
| `Montserrat-ExtraBold.ttf` | Montserrat ExtraBold (statique) | https://github.com/JulietaUla/Montserrat (`fonts/ttf/`)     | `OFL-Montserrat.txt` |
| `Inter-Bold.ttf`           | Inter Bold (statique)           | https://github.com/rsms/inter, version 4.1 (`extras/ttf/`) | `OFL-Inter.txt`      |

Les fichiers ne sont pas modifiés. Leur empreinte SHA-256 est vérifiée par `npm run doctor`.
