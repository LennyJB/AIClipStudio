# Import de rediffusions Twitch et fichiers mono-piste (étape 8)

## Ce qui est pris en charge

| Fichier                                              | Conteneur | Pistes audio                    | Rôles                                            |
| ---------------------------------------------------- | --------- | ------------------------------- | ------------------------------------------------ |
| Enregistrement OBS                                   | MKV, MP4  | plusieurs, nommées ou ordonnées | nom de piste, sinon `AUDIO_TRACK_ROLES`          |
| Rediffusion Twitch téléchargée (TwitchDownloader…)   | MP4       | une, mixée                      | `mix` (« Tout »), `single_track`                 |
| Flux Twitch enregistré tel quel (streamlink, FFmpeg) | MPEG-TS   | une, mixée                      | `mix` (« Tout »), `single_track`                 |
| Autre fichier vidéo                                  | MOV, M4V  | une ou plusieurs                | `mix` si une seule ; sans nom hors OBS : inconnu |

Aucune connexion à Twitch, aucune API, aucun téléchargement automatique : le fichier est déjà sur
le disque ; il est **référencé, jamais modifié ni copié**.

## Rôles supposés (pistes sans nom)

Dans un MKV ou un MP4 multipiste dont les pistes n'ont pas de nom, l'ordre `AUDIO_TRACK_ROLES`
donne des rôles **suggérés** (`roleSource: config`, avertissement `track_roles_from_config`) :
ces pistes ne sont **ni exportées ni sous-titrées** (exigence `confirmation` / `track_roles`)
tant que le créateur n'a pas **confirmé explicitement** les rôles (interface : « Confirmer ces
rôles », ou `PATCH /api/recordings/:id/tracks`, provenance `override`). Une déclaration de
composition ne vaut pas confirmation ; après confirmation, les déclarations et accords habituels
restent exigés, et une révocation bloque de nouveau. Pistes nommées par OBS et piste unique :
inchangées (aucune confirmation demandée).

## Piste unique mixée

- Toujours « Tout » (`mix`) : jamais supposée être le micro, le jeu ou Discord.
- Le son d'origine est conservé tel quel : **aucune séparation des voix, aucune atténuation
  automatique, aucune classification** de son contenu.
- Transcription : WAV mono 16 kHz de cette piste ; montage : WAV stéréo 48 kHz limité à la
  fenêtre du clip, mis en cache ; jamais superposée à d'autres pistes.
- Export et sous-titres : la **composition** de la piste doit être déclarée (voix Discord, chat
  vocal du jeu, autres voix), puis chaque catégorie présente doit avoir son **accord**. Une
  composition inconnue n'est jamais considérée comme autorisée ; une révocation bloque de nouveau.

## Contrôle de lecture à l'import

| Anomalie                    | Gravité | Signification                                                                                  |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `truncated`                 | grave   | fin annoncée illisible ; seule la partie lisible est exploitable (durée mesurée)               |
| `decode_errors`             | grave   | erreurs de lecture au début, à la fin ou en cours de fichier                                   |
| `duration_unknown`          | grave   | durée introuvable même en lisant le fichier                                                    |
| `duration_mismatch`         | grave   | durées incohérentes ; la durée mesurée est retenue                                             |
| `audio_track_short`         | grave   | une piste audio s'arrête bien avant la fin                                                     |
| `audio_metadata_incomplete` | grave   | codec, fréquence ou nombre de canaux absent                                                    |
| `duration_estimated`        | info    | MPEG-TS : durée estimée par le conteneur, mesurée à l'import                                   |
| `audio_track_offset`        | info    | une piste audio commence après le début (compensé par du silence)                              |
| `video_track_offset`        | info    | la vidéo commence après le début du fichier                                                    |
| `track_roles_from_config`   | info    | rôles supposés d'après l'ordre des pistes : export et sous-titres bloqués jusqu'à confirmation |

Un enregistrement avec une anomalie grave est **« partiellement exploitable »**
(`health.status: degraded`) dans l'API, l'interface et la ligne de commande. Un MP4 sans index
(téléchargement interrompu) ou un fichier qui n'est pas un média est refusé à l'import.

Coût du contrôle : décodage de 3 s au début et à la fin ; lecture complète des paquets (sans
décodage) seulement si la durée est absente, estimée, incohérente ou si la fin manque.

## Hors périmètre

Séparation automatique des voix, atténuation automatique, classification audio, détection des
passages coupés par Twitch (silences) : rien de tout cela n'est fait.
