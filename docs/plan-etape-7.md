# Plan technique — Étape 7 : éditeur vidéo avec timeline

> **Statut : plan validé par le créateur (version 4).** Mise en œuvre en PR successives
> (§8), chacune relue, validée et fusionnée avant la suivante. Les précisions apportées pendant
> la mise en œuvre sont consignées au § 14.
> Base analysée : `main` au commit `379876f` (fusion de la PR #17, étape 6c).

---

## 0. État réel de `main`

### 0.1 Ce qui existe déjà et sera réutilisé

| Domaine             | Existant (fichier)                                                                                                                                                                                                                                                        | Limite actuelle                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modèle temporel     | `packages/timeline/src/time.ts` : `SourceMs`/`EditMs` marqués ; segments `source` (avec `speed`) et `freeze` ; conversions `editToSource`, `sourceToEdit`, `sourceRangeToEditRanges`, `resolveTiming` ; `moveSegment`, `updateSegment` ; tests                            | Pures et testées, mais jamais exploitées au-delà d'un segment                                                                                                                                      |
| Projet de clip      | `project.ts` : `ClipProject` v1 (jusqu'à 200 segments dans le schéma, mise en page par préréglage avec rectangles, `focusX`, part de facecam, masques globaux, sous-titres générés depuis les mots avec corrections, 3 effets, pistes audio avec gain) ; `migrateProject` | `adjustBounds` et tous les réglages supposent **un seul segment** ; `migrateProject` ne connaît que la v1                                                                                          |
| Persistance         | `clip_project_revisions` : document complet par révision, immuable ; `baseRevision` et `requestId` ; `PATCH` avec `RenderOptionsPatchSchema`                                                                                                                              | Une révision complète par modification : inadapté à des centaines de gestes d'édition                                                                                                              |
| Rendu               | `packages/render` : plan pur (`buildRenderPlan`), masques opaques avant recadrage, ASS/libass, `zoompan`, `loudnorm`, consentements revérifiés, publication sous verrou, récupération                                                                                     | **Refuse** plusieurs segments, l'arrêt sur image et la vitesse ≠ 1 (`plan.ts`) ; graphe passé en argument de ligne de commande (limite de 32 Ko sous Windows) ; pas de calques ni d'effets sonores |
| Image fixe          | `GET /api/clip-projects/:id/frame`, annulable, plafonnée (6c)                                                                                                                                                                                                             | Sans sous-titres ni zoom                                                                                                                                                                           |
| Dérivés médias      | `media_derivatives`, file de traitements avec `target_key` ; pistes de montage 48 kHz stéréo par fenêtre (`requestAudioStems`) ; formes d'onde `.dat` ; images `frame`                                                                                                    | `video_proxy` et `thumbnail` sont **déclarés dans le schéma mais jamais produits** ; pas de baux contre le nettoyage pendant l'édition (prévus « à l'étape 7 », `architecture.md` §5)              |
| Intégrité           | Manifeste par octets (MKV/MP4) sur la fenêtre `adjustableWindow` (proposition ±10 s), repli sur le fichier entier ; manifestes figés (déclencheur `source_integrity_manifests_frozen`)                                                                                    | Toute extension d'édition au-delà de la fenêtre couverte exige un **nouveau** manifeste                                                                                                            |
| Audio exporté       | `allowedAudio`, déclarations, accords, historique (6a/6c)                                                                                                                                                                                                                 | Aucun changement nécessaire : l'éditeur s'y branche                                                                                                                                                |
| Serveur             | Écoute sur `127.0.0.1` par défaut (`API_HOST`, configurable)                                                                                                                                                                                                              | Aucune restriction propre aux fichiers de travail si `API_HOST` est modifié                                                                                                                        |
| Web                 | React 19 seul ; pas de routeur, pas de bibliothèque d'état ; `ClipEditor` de la 6c                                                                                                                                                                                        | Aucune lecture vidéo, aucune timeline                                                                                                                                                              |
| Import piste unique | `resolveTrackRoles` : un fichier à piste unique reçoit le rôle `mix` (`single_track`) ; transcription et montage se replient sur le mix                                                                                                                                   | Pas de parcours d'import dédié (étape 8, §11)                                                                                                                                                      |

### 0.2 Ce qui n'existe pas du tout

- Lecture vidéo dans le navigateur.
- Timeline.
- Annuler / rétablir.
- Calques (images, mèmes, texte).
- Bibliothèque de médias.
- Effets sonores.
- Masques temporels.
- Mise en page libre.
- Rendu multi-segments.

---

## 1. Décisions validées par le créateur

| #   | Sujet                 | Décision                                                                                                                                                                                                                 |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Aperçu                | Composition **canvas** dans le navigateur + **FFmpeg** pour l'export ; **image exacte** fournie par FFmpeg à la demande. Pas de Remotion.                                                                                |
| 2   | Persistance           | **Journal d'opérations en ajout seul** + **points de contrôle** (révisions immuables existantes).                                                                                                                        |
| 3   | Fenêtre éditable      | **±60 s** autour de la proposition pour les **nouveaux** projets. Les **projets existants conservent leur fenêtre actuelle** (celle de leur manifeste). Toute extension crée un **nouveau manifeste d'intégrité**.       |
| 4   | Hors périmètre        | Plusieurs enregistrements dans un clip, vitesse ≠ 1, transitions animées, musique longue.                                                                                                                                |
| 5   | Écoute                | Seules les pistes **autorisées et activées** sont audibles dans l'éditeur.                                                                                                                                               |
| 6   | Proxy                 | Proxy vidéo **non masqué**, **strictement local et protégé** (§5.2 : adresse réelle du socket, `Host`, `Origin`, requêtes intersites, jeton éphémère, CORS fermé). Masques appliqués dans l'aperçu **et** dans l'export. |
| 7   | Dépendances           | `zustand`, `fast-check`, Playwright dans la CI, **versions verrouillées** (exactes, sans `^`, `package-lock.json`) ; installation de Chromium dans la CI.                                                                |
| 8   | Mèmes                 | **Images fixes** uniquement à l'étape 7 ; GIF animés plus tard.                                                                                                                                                          |
| 9   | Twitch / piste unique | **Étape 8** séparée. L'étape 7 prend correctement en charge les projets à piste unique « Tout », **sans inventer de séparation des sources**.                                                                            |

---

## 2. Principes d'architecture

1. **Le projet de clip reste la source unique de vérité.** L'éditeur ne produit que des
   **opérations typées** appliquées par un réducteur **pur, partagé entre l'interface et le
   serveur** (`@acs/timeline`). Le serveur rejoue chaque opération et compare l'empreinte obtenue
   avec celle annoncée par le client.
2. **Export : FFmpeg, conservé** avec toutes ses garanties : masques, consentements, intégrité,
   publication sous verrou, récupération.
3. **Aperçu interactif** :
   - **proxy vidéo** H.264 léger de la fenêtre éditable ;
   - **pistes audio de montage** (existantes) mixées par Web Audio ;
   - **composition sur canvas**.
4. **Description de scène pure** (`@acs/timeline/scene`) consommée par le canvas **et** par le
   plan FFmpeg :
   - pour un temps montage donné, elle calcule les calques, leurs rectangles en pixels, les
     masques, les zooms, les sous-titres visibles, les calques graphiques et le mixage ;
   - même géométrie, mêmes coupures de lignes, mêmes polices OFL.
   - **Limite assumée** : le rendu du texte (libass contre canvas) peut différer de quelques
     pixels. Le bouton « Image exacte » (FFmpeg) et l'aperçu FFmpeg existant font foi.
5. **Annuler / rétablir par opérations inverses**, enregistrées dans le journal (§6). Le journal
   ne recule jamais.
6. **Aucune règle de consentement côté interface** : le serveur revérifie à chaque lot
   d'opérations, à chaque aperçu et à chaque export.

---

## 3. Modèle de données (`ClipProject` v2)

### 3.1 Migration du document

- `migrateProject` v1 → v2 est pure et testée.
- Les révisions v1 stockées ne sont **jamais réécrites** : elles sont migrées à la lecture.
- **Fenêtre éditable d'un projet migré** : celle de son manifeste d'intégrité existant (la fenêtre
  ajustable ±10 s de la 6a). Elle n'est **pas** élargie automatiquement.
- **Nouveaux projets** : fenêtre = proposition ± `EDITOR_WINDOW_MARGIN_SEC` (60 s par défaut,
  documentée dans `.env.example`), bornée à la durée de l'enregistrement, couverte par un
  manifeste construit à la création.

### 3.2 Schéma

| Partie              | v2                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segments`          | Segments `source`, `freeze` et **`gap`** (§3.3) ; `speed` limité à 1 (refus explicite) ; chaque segment `source` ou `freeze` reste dans la fenêtre éditable                                                                                                                                                         |
| `source.editWindow` | `{ srcStartMs, srcEndMs, integrityManifestId }`. **Élargir** = opération explicite qui construit un **nouveau** manifeste (les manifestes restent figés) et remplace la référence. Le rendu vérifie que tous les segments sont dans la fenêtre du manifeste référencé                                               |
| `layout`            | `preset` ou `custom`. En `custom` : `layers[]` (`gameplay` ou `facecam`, `crop` dans le repère source, `frame` dans le repère 9:16, ordre d'empilement, fond) ; surcharge facultative par segment (`layoutOverrides[segmentId]`)                                                                                    |
| `masks`             | Masques de **confidentialité** : **toujours opaques** (aplat plein, appliqué sur l'image source avant tout recadrage, §3.4). Masques globaux (profil) + **masques temporels** (rectangle source, plage en temps source). Désactivation d'un masque : confirmation explicite et avertissement permanent, comme en 6c |
| `captions`          | Items issus de la transcription **immuables**. Ajouts : surcharges par item (horaires bornés aux mots, découpage et fusion, style et position) et **sous-titres manuels** (`origin: 'creator'`, pseudonymisés eux aussi). Corrections tracées comme aujourd'hui                                                     |
| `effects`           | Catalogue v2 avec `defineEffect({ type, params: Zod, ffmpeg(), preview() })`. Effets visuels : `zoom` (zone cible), `flash`, `shake`, **`blur_region` (effet créatif uniquement, §3.4)**, effets existants. Effets audio : `fade_in/out`, `duck`, `bleep`. Ancrage `source` ou `edit`                               |
| `overlays`          | `image`, `meme` (**images fixes uniquement** à l'étape 7), `text` ; `assetId`, horaires, cadre, opacité, ordre d'empilement                                                                                                                                                                                         |
| `audio`             | `tracks` (gain, désactivation) + **automatisation** (points de gain en temps source) ; piste `sfx[]` (`assetId`, horaires, gain) ; mixage toujours borné par `allowedAudio`                                                                                                                                         |

### 3.3 Sémantique du montage (définie dans le modèle et testée)

**Arrêt sur image (`freeze`)** :

- **Vidéo** : l'image source à `srcAtMs` reste affichée pendant `editDurMs`, avec les mêmes masques
  (ceux dont la plage contient `srcAtMs`), la même mise en page et les mêmes zooms.
- **Audio des pistes de l'enregistrement** : **silence** sur toutes les pistes source pendant
  l'arrêt. Aucune boucle, aucun étirement, aucune reprise du son.
- **Éléments ancrés en temps source** (sous-titres, effets, effets sonores ancrés au contenu) :
  affichés **figés** pendant l'arrêt si leur plage contient `srcAtMs`. C'est le comportement déjà
  défini par `sourceRangeToEditRanges` (`frozen: true`). Un effet sonore ancré en temps source
  n'est **pas** rejoué pendant l'arrêt : il est joué une seule fois, à sa première occurrence
  non figée.
- **Éléments ancrés en temps montage** (calques, effets sonores ancrés à la structure) :
  continuent normalement.
- **Raccords** : fondu audio de 8 ms à chaque entrée et sortie de segment (anti-clic), identique
  dans l'aperçu et dans l'export.

**Suppression d'un segment** : deux opérations distinctes.

- `rippleDelete` (suppression **avec** décalage) : le segment est retiré ; les suivants avancent ;
  la durée totale diminue.
- `liftDelete` (suppression **sans** décalage) : le segment est **remplacé par un segment `gap`**
  de même durée de montage (`{ id, kind: 'gap', editDurMs }`).
  - **Image** : fond de la mise en page (noir par défaut), **sans** image source, donc sans risque
    de fuite d'une zone sensible.
  - **Son** : silence sur toutes les pistes source.
  - **Éléments ancrés en temps montage** (calques, effets sonores de structure) : continuent.
  - **Éléments ancrés en temps source** : rien ne leur correspond pendant un `gap`, ils
    n'apparaissent pas.
  - La durée totale est inchangée.
- **Invariants testés** :
  - un `gap` n'a pas de temps source : `editToSource` y renvoie exactement
    `{ kind: 'gap', segmentId }` ; `null` est réservé aux instants hors du clip (§14) ;
  - `sourceToEdit` ignore les `gap` ;
  - la durée totale inclut les `gap` ;
  - un clip ne peut pas commencer ni finir par un `gap` (refus explicite : un fond noir en
    ouverture ou en fin serait un défaut silencieux).

### 3.4 Confidentialité

- **Seuls les aplats opaques sont une protection de confidentialité.** C'est la règle de l'étape 6
  (§7.2 et décision 4 du plan de l'étape 6), inchangée.
- **`blur_region` est un effet créatif** :
  - il n'est jamais proposé, nommé ni compté comme un masque ;
  - il ne lève aucun avertissement `MASKS_DISABLED` ;
  - il ne remplace jamais un masque désactivé ;
  - il est appliqué **après** les aplats opaques : un flou ne peut pas « adoucir » un masque ;
  - l'interface le range dans « Effets », jamais dans « Zones masquées ». Une info-bulle indique :
    « Le flou n'est pas une protection : utilisez une zone masquée. »
- **Masques temporels** : opaques uniquement, appliqués sur l'image source avant recadrage, dans
  l'aperçu comme dans l'export.
- **Désactivation d'un masque** : confirmation explicite, avertissement permanent dans l'éditeur,
  `MASKS_DISABLED` dans le rendu.

---

## 4. Timeline et interactions

**Pistes affichées :**

- Vidéo (segments, `gap` hachurés, arrêts sur image marqués, vignettes) ;
- Calques ;
- Sous-titres ;
- Effets ;
- une piste par source audio (forme d'onde, gain, désactivation ; une seule piste « Tout » pour un
  enregistrement à piste unique) ;
- Effets sonores.

**Opérations :**

| Domaine           | Opérations                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segments          | `splitAt`, `trimStart/End` (rogner ou allonger dans la fenêtre), `moveSegment` (réordonner), `rippleDelete`, `liftDelete`, `insertFreeze`, `extendWindow` (nouveau manifeste) |
| Sous-titres       | `retimeCaption`, `splitCaption`, `mergeCaptions`, `editCaptionText`, `addManualCaption`, `styleCaption`                                                                       |
| Cadrage           | `setLayer` (poignées sur le canvas), `setMask` (opaque ou désactivé avec confirmation), `addTimedMask`                                                                        |
| Effets et calques | `add/update/remove` pour les effets, calques graphiques et effets sonores                                                                                                     |
| Audio             | `setGain`, `setAutomation`, `setTrackEnabled`                                                                                                                                 |

**Ergonomie :**

- aimantation : tête de lecture, bords de segments, frontières de mots, sous-titres ;
- zoom et défilement ;
- raccourcis : S (couper), J/K/L, ←/→ image par image, Suppr (avec décalage), Maj+Suppr (sans
  décalage), Ctrl+Z / Ctrl+Maj+Z.

**Un geste = un lot d'opérations = une entrée d'historique** : un glissement est fusionné au
relâchement.

**Rendu de l'interface** : éléments en DOM (accessibles, testables), formes d'onde et vignettes sur
canvas, conversion pixels ↔ millisecondes pure et testée.

---

## 5. Prévisualisation et rendu

### 5.1 Médias de travail (file de traitements existante)

- **Proxy vidéo** : H.264, 540 p, groupe d'images court, sur la fenêtre éditable, **sans
  masque** (décision 6).
- **Planche de vignettes** : produite **depuis l'image masquée** (même aplat que l'export). Les
  vignettes sont petites, durables et affichées hors du canvas : elles ne doivent jamais montrer
  de zone sensible.
- **Pistes de montage** et **formes d'onde** : existent déjà.

### 5.2 Protection du proxy non masqué

Le proxy est le seul fichier de travail qui montre l'image source **sans** aplats. Il est donc
traité comme une donnée sensible, avec plusieurs contrôles indépendants. Chacun est vérifié par un
test dédié (§8.2, PR 7d). Les **mêmes contrôles** s'appliquent aux pistes audio de montage servies
à l'éditeur : elles peuvent contenir des voix non autorisées à l'export, et l'éditeur ne demande
de toute façon que les pistes autorisées et activées (décision 5).

**Stockage**

- Uniquement dans `storage/processing/editor/`.
- Jamais copié dans `exports/`, jamais utilisé par l'export (qui relit l'original).
- Jamais servi par un chemin fourni par le client : l'API résout l'identifiant du dérivé en base.

**Adresse réelle de la connexion**

- Seule l'adresse du **socket TCP** fait foi (`req.raw.socket.remoteAddress`) : `127.0.0.1`,
  `::1` ou `::ffff:127.0.0.1`. Sinon : 403.
- **Aucune confiance** dans `X-Forwarded-For`, `X-Real-IP`, `Forwarded` ni dans un proxy
  configuré. L'option `trustProxy` de Fastify reste désactivée (c'est le cas aujourd'hui), et un
  test d'architecture échoue si elle est activée.
- En développement, les requêtes passent par le proxy de Vite : la connexion reçue par l'API est
  celle du processus Vite, lui-même à l'écoute sur `127.0.0.1` uniquement (`strictPort`). Elle est
  donc bien locale (mesuré : `remoteAddress = 127.0.0.1`).

**Mesures réelles avec la configuration du dépôt** (Vite 8.3.8 de `node_modules`,
`apps/web/vite.config.ts` inchangé avec `changeOrigin: false`, Chromium de Playwright, serveur
d'écho à la place de l'API) :

| Requête                                             | `Host` reçu par l'API | `Origin`                | `Sec-Fetch-Site` | Autres                                                               |
| --------------------------------------------------- | --------------------- | ----------------------- | ---------------- | -------------------------------------------------------------------- |
| `fetch` GET de l'interface (même origine)           | `127.0.0.1:5173`      | absent                  | `same-origin`    | `mode: cors`                                                         |
| `fetch` POST JSON de l'interface (demande de jeton) | `127.0.0.1:5173`      | `http://127.0.0.1:5173` | `same-origin`    | `mode: cors`                                                         |
| `<video src>` de l'interface (lecture du média)     | `127.0.0.1:5173`      | **absent**              | `same-origin`    | `mode: no-cors`, `dest: video`, `Range: bytes=0-`                    |
| `<video src>` depuis une page d'une autre origine   | `127.0.0.1:5173`      | **absent**              | `cross-site`     | `mode: no-cors`                                                      |
| `fetch` POST depuis une page d'une autre origine    | `127.0.0.1:5173`      | `http://localhost:4999` | `cross-site`     | —                                                                    |
| `curl` vers Vite avec `Host: localhost:5173`        | `localhost:5173`      | absent                  | absent           | —                                                                    |
| `curl` vers Vite avec `Host: evil.example:5173`     | jamais reçu           | —                       | —                | **refusé par Vite (403)**, protection `allowedHosts` intégrée à Vite |

Constats :

- avec `changeOrigin: false`, **Vite conserve le `Host` d'origine** : l'API reçoit
  `127.0.0.1:5173` (ou `localhost:5173`), **jamais** son propre port ;
- Vite n'ajoute **aucun** en-tête `X-Forwarded-*` ni `Forwarded` ;
- une balise `<video>` n'envoie **jamais** `Origin`, même depuis la page de l'interface ;
- `Sec-Fetch-Site` distingue bien la page de l'interface (`same-origin`) d'une autre page
  (`cross-site`).

**En-tête `Host`**

- Règle : `Host` doit être **exactement** le couple `hôte:port` de l'une des origines autorisées
  (`EDITOR_ALLOWED_ORIGINS`, ci-dessous). Avec la valeur par défaut : `127.0.0.1:5173` ou
  `localhost:5173`. Sinon : 403 (protection contre le rebinding DNS).
- La liste des `Host` acceptés est **déduite** de celle des origines. Il n'existe aucune seconde
  liste, et la liste n'est pas élargie au port de l'API : l'interface n'est jamais servie par
  l'API (vérifié : aucun service de fichiers statiques), donc aucun usage légitime n'appelle ces
  routes avec `Host: 127.0.0.1:4000`.
- Un `Host` étranger est refusé **deux fois** :
  - par Vite (`allowedHosts`), lorsque la requête passe par lui ;
  - par l'API, lorsque la requête arrive directement sur son port.

  Les deux contrôles sont testés séparément ; la sécurité ne repose pas sur Vite.

**Origine des requêtes (`Origin`)**

- Liste blanche **exacte** `EDITOR_ALLOWED_ORIGINS`, par défaut
  `http://127.0.0.1:5173,http://localhost:5173` : l'adresse documentée dans le README et le nom que
  Vite accepte aussi. Variable documentée dans `.env.example` ; toute origine non locale
  (autre que `127.0.0.1`, `localhost`, `[::1]`) ou non `http:` fait échouer le démarrage.
- Une origine **présente mais non autorisée** est **toujours** refusée (403), sur toutes les routes
  concernées, y compris `Origin: null` (pages `file:`, iframes isolées).

Comportement selon la route :

| Route                                                                       | `Origin` absent                                                               | `Origin` autorisé                       | `Origin` présent non autorisé ou `null` |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| **Demande de jeton** (`POST`, JSON)                                         | **403**                                                                       | accepté si les autres contrôles passent | 403                                     |
| **Lecture du média** (proxy, pistes de montage ; `GET`/`HEAD` avec `Range`) | **accepté seulement avec un jeton valide** et si les autres contrôles passent | accepté si les autres contrôles passent | 403                                     |

- **Demande de jeton** : un navigateur envoie toujours `Origin` sur un `POST` (mesuré). Une absence
  signifie un client hors navigateur ou une requête anormale : refus. La route exige aussi
  `Content-Type: application/json` (une page d'une autre origine ne peut l'envoyer sans requête
  préliminaire, refusée) et `Sec-Fetch-Site: same-origin` quand l'en-tête est présent.
- **Lecture du média** : l'absence d'`Origin` est **nécessaire** au fonctionnement. Les requêtes
  d'une balise `<video>` (premier chargement et requêtes `Range` suivantes) n'envoient pas cet
  en-tête (mesuré). La protection repose alors sur :
  - **`Sec-Fetch-Site`** : s'il est présent, seul `same-origin` est accepté. **`same-site` est
    refusé** : pour une adresse IP, un autre port de la même machine est « même site ». Une autre
    application web locale (par exemple sur `127.0.0.1:3000`) serait donc « même site » sans être
    l'interface. Cette règle corrige la version 3, qui acceptait `same-site` ;
  - **le jeton éphémère**, qui suffit même si `Sec-Fetch-Site` est absent (navigateur ancien).

**Pourquoi le jeton protège quand `Origin` est absent**

Une page d'une autre origine peut insérer `<video src="…/proxy">` : son navigateur enverra la
requête sans `Origin`. Elle ne peut pourtant pas lire le média, parce qu'il lui faudrait un jeton
valide, et elle ne peut pas en obtenir :

1. la demande de jeton exige un `Origin` autorisé, que le navigateur fixe lui-même et qu'une page
   ne peut pas falsifier ;
2. la réponse n'est lisible que par la même origine (aucun en-tête CORS) ;
3. le jeton fait 256 bits, il est signé (HMAC, clé aléatoire en mémoire, renouvelée à chaque
   démarrage) et ne peut pas être deviné ;
4. il est lié au projet, au dérivé et au bail, et expire après 10 minutes ;
5. il n'apparaît ni dans les journaux du serveur, ni dans un en-tête `Referer`
   (`Referrer-Policy: no-referrer`) ;
6. `Cross-Origin-Resource-Policy: same-origin` empêche en plus le navigateur de livrer la réponse
   à une page d'une autre origine, même avec un jeton.

**Hors du modèle de menace, à dire clairement** : un programme qui s'exécute déjà sur le poste peut
lire directement `storage/processing/`. Ces contrôles protègent le proxy contre les autres
machines et les pages web, pas contre un logiciel local malveillant.

**Jeton éphémère** : obtenu par la demande de jeton ci-dessus ; renouvelé par l'éditeur avant son
expiration ; passé en paramètre de l'URL du média ; paramètre masqué dans les journaux. Sans jeton
valide : 403.

**CORS restrictif**

- Aucun en-tête `Access-Control-Allow-Origin` sur ces routes (le serveur n'en émet aucun
  aujourd'hui, aucune extension CORS n'étant installée).
- Une requête préliminaire `OPTIONS` reçoit 403.
- `Cross-Origin-Resource-Policy: same-origin`, qui empêche aussi l'intégration du média par une
  autre origine.

**Autres en-têtes** : `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`.

**`Content-Disposition: inline` n'est pas une protection.** Il indique seulement au navigateur
d'afficher le fichier plutôt que de proposer de l'enregistrer : quiconque peut lire l'URL peut
enregistrer la vidéo. La protection repose uniquement sur les contrôles d'accès ci-dessus, et sur
le fait que le poste du créateur est le seul client autorisé.

**Durée de vie**

- `npm run doctor` avertit si `API_HOST` n'est pas une adresse de bouclage. Dans ce cas, les routes
  du proxy restent refusées à toute connexion non locale.
- Protégé du nettoyage **seulement** pendant un bail actif. Le bail expire après la fermeture de
  l'éditeur : le proxy redevient un cache évinçable.
- **Les masques sont dessinés par l'aperçu** au-dessus du proxy, au **même moment** que l'image
  (même description de scène). Une zone masquée n'est donc jamais visible dans le canvas. Test
  dédié en 7e/7h : pixels du canvas sous une zone masquée = aplat.

### 5.3 Lecteur

- L'horloge maître est l'`AudioContext`.
- À chaque image : temps montage → `editToSource` (ou `gap` / arrêt sur image) → temps du média.
- Deux éléments `<video>` en double tampon : le suivant est préchargé au début du segment suivant.
- Web Audio applique les gains, l'automatisation, les effets sonores, les fondus de raccord et le
  silence des arrêts sur image et des `gap`.
- **Seules les pistes autorisées (décision du serveur) et activées sont chargées et audibles.**
  Une piste non autorisée n'est pas lue, même localement.

### 5.4 Export (FFmpeg)

- Plan construit depuis la scène :
  - une entrée source (`-ss` sur la fenêtre éditable) ;
  - `trim`/`atrim` + `setpts` par segment, puis `concat` ;
  - arrêt sur image : image figée (`tpad`/`loop`) + **silence** (`anullsrc` de la durée de
    l'arrêt) ;
  - `gap` : `color` (fond) + silence ;
  - aplats opaques (globaux, et temporels avec `enable`) sur l'image source **avant** recadrage ;
  - effets visuels, dont `blur_region`, **après** les aplats ;
  - calques par `overlay` (entrées par index, chemins uniquement en arguments) ;
  - effets sonores par `adelay` + `amix` ;
  - texte via ASS échappé.
- **Graphe dans un fichier** (`-filter_complex_script`, nom relatif dans le dossier de travail) :
  plus de limite de longueur de ligne de commande sous Windows.
- **Avant tout rendu, un point de contrôle est créé** (fonction livrée en 7b, §8), car la
  contrainte de clé étrangère `clip_renders` → révision l'exige.
- **Inchangé** :
  - publication sous verrou ;
  - récupération ;
  - nouvelle vérification des accords, des déclarations et de la confidentialité ;
  - original jamais modifié.

---

## 6. Sauvegarde, annuler / rétablir et reprise

### 6.1 Journal

Table `clip_project_edits` (migration 8), en ajout seul. Chaque entrée = un lot :

| Champ                       | Rôle                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `seq`                       | Ordre total par projet (sans trou)                                                             |
| `kind`                      | `do` (geste), `undo`, `redo`, `system` (proposition d'effets, `PATCH` v1, CLI)                 |
| `target_seq`                | Pour `undo`/`redo` : l'entrée annulée ou rétablie                                              |
| `ops_json`, `inverse_json`  | Opérations appliquées et leurs inverses, calculées par le réducteur au moment de l'application |
| `preconditions_json`        | Valeurs attendues avant application (§6.3)                                                     |
| `hash_after`                | Empreinte canonique du document après le lot                                                   |
| `base_revision`, `base_seq` | Tête sur laquelle le lot a été construit                                                       |
| `client_id`                 | Identifiant de l'onglet (diagnostic, libellés)                                                 |
| `request_id`                | Unique : un renvoi est rejoué, jamais dupliqué                                                 |
| `source`, `created_at`      | Traçabilité                                                                                    |

- **Chargement** : dernier point de contrôle + rejeu des entrées suivantes. Le rejeu est
  déterministe et chaque `hash_after` est vérifié. Un écart rend le projet non modifiable avec une
  erreur explicite : jamais de correction silencieuse.
- **Points de contrôle** (révisions immuables) : avant un rendu, tous les 200 lots, à la fermeture
  de l'éditeur, sur « Enregistrer une version ». Un point de contrôle ne tronque jamais le journal.

### 6.2 Annuler / rétablir

**Modèle** : un historique **linéaire par projet**, dérivé uniquement du journal par une fonction
pure `historyState(journal)`. Le même code sert au serveur et à l'interface.

- **Pile « annuler »** : les entrées `do`/`system`/`redo` encore en vigueur, de la plus récente à la
  plus ancienne.
- **Pile « rétablir »** : les entrées annulées depuis le dernier `do`. Un nouveau `do` la vide,
  comme dans tout éditeur.
- **Annuler** ajoute au journal une entrée `undo` qui applique `inverse_json` de l'entrée en haut de
  pile.
- **Rétablir** ajoute une entrée `redo` qui réapplique ses `ops_json`.
- Aucune entrée n'est jamais modifiée ni supprimée.

**Requête** : `POST /api/clip-projects/:id/edits` avec
`{ kind: 'undo' | 'redo', targetSeq, base: { revision, seq }, requestId }`. Sous
`BEGIN IMMEDIATE`, le serveur vérifie, dans l'ordre :

1. la décision effective (garde existante) : sinon `PROPOSAL_NOT_ACCEPTED`, projet en lecture
   seule ;
2. que `targetSeq` est **exactement** le haut de la pile correspondante à la tête actuelle : sinon
   `HISTORY_CHANGED` (409) avec la nouvelle tête ;
3. les préconditions de l'inverse (§6.3) ;
4. les invariants et l'audio autorisé **aujourd'hui** : un retour en arrière qui réactiverait une
   piste dont l'accord a été révoqué est **refusé** (`EXPORT_CONSENT_REQUIRED`), l'historique reste
   intact et l'interface explique pourquoi ;
5. l'empreinte obtenue.

**Après rechargement ou fermeture de l'application** :

- l'historique est reconstruit depuis le journal : on peut annuler un geste fait avant le
  rechargement, ou la veille ;
- l'interface limite l'affichage aux 200 dernières entrées ; le journal reste complet ;
- annuler après un export ne touche pas le fichier exporté (révision immuable).

**Lots non encore envoyés** (file locale ou brouillon IndexedDB) :

- annuler un lot **non envoyé** le retire simplement de la file locale, sans rien envoyer ;
- annuler pendant l'envoi d'un lot attend sa confirmation, puis passe par le serveur.

**Plusieurs onglets** :

- chaque onglet a un `client_id` ;
- les nouveaux lots sont diffusés aux autres onglets par `BroadcastChannel`, avec une relecture
  périodique de la tête en secours ;
- un onglet **sans lot en attente** avance simplement jusqu'à la nouvelle tête ;
- l'historique étant par projet, « Annuler » dans l'onglet A annule l'entrée la plus récente,
  **même si elle vient de l'onglet B**. Le libellé l'indique avant l'action : « Annuler :
  déplacement du segment 3 (autre onglet) ». Il n'y a jamais de surprise silencieuse : si la tête a
  changé entre l'affichage et le clic, le serveur répond `HISTORY_CHANGED`, l'onglet se met à jour
  et rien n'est annulé ;
- les entrées `system` et CLI sont annulables comme les autres, avec leur source affichée.

### 6.3 Conflits

**Principe : aucune réapplication automatique sur la seule base d'identifiants différents.** Une
réapplication n'a lieu que si l'**indépendance réelle** est démontrée et que les **préconditions**
sont vérifiées. Sinon, conflit explicite, sans perte du brouillon.

Chaque opération déclare, de façon pure et testée :

- **un ensemble lu** et **un ensemble écrit**, au niveau du champ (par exemple `segment:s3.srcEndMs`,
  `caption:c12.text`, `layout.layers.facecam.frame`) ;
- **des dépendances structurelles** :
  - toute opération dont le résultat dépend des positions en temps montage (élément ancré en temps
    montage, opération à la tête de lecture, `splitAt`) **lit la structure entière des segments** ;
  - toute opération qui change la structure (`split`, `trim`, `move`, `delete`, `freeze`, `gap`,
    `extendWindow`) **écrit** cette structure ;
- **des préconditions** : valeurs attendues des champs lus (par exemple « `s3.srcEndMs` vaut
  12 400 »), vérifiées au moment de l'application.

**Réapplication automatique** d'un lot local construit sur une ancienne tête, autorisée seulement
si **toutes** les conditions sont réunies. Notations : `L` = lot local, `D` = ensemble des entrées
distantes intermédiaires ; `lu(x)` et `écrit(x)` comprennent les dépendances structurelles.

1. **Écritures distantes contre lectures et écritures locales** :
   `écrit(D) ∩ (lu(L) ∪ écrit(L)) = ∅` ;
2. **Lectures distantes contre écritures locales** (sens inverse, **obligatoire**) :
   `lu(D) ∩ écrit(L) = ∅`. Une entrée distante dont le résultat dépendait d'une valeur que `L`
   modifie aurait été calculée différemment si `L` était passé avant : l'ordre change le résultat,
   la réapplication est refusée ;
3. aucune entrée de `D` n'est un `undo`/`redo` qui touche un champ lu ou écrit par `L` ;
4. les **préconditions de `L`** sont vraies sur la nouvelle tête, **et** les préconditions de
   chaque entrée de `D` sont vraies sur le document obtenu en appliquant `L` en premier.
   Autrement dit, les deux ordres sont valides ;
5. **contrôle de résultat** : le document obtenu par `D` puis `L` a la même empreinte canonique que
   celui obtenu par `L` puis `D`. Le serveur calcule les deux ; une différence entraîne un refus,
   même si les conditions 1 à 4 étaient remplies (filet de sécurité contre une déclaration
   incomplète des ensembles lus ou écrits) ;
6. le document obtenu respecte tous les invariants (durée, fenêtre, audio autorisé) ;
7. aucune opération de `L` ne touche aux masques ni à l'audio. Ces opérations ne sont **jamais**
   réappliquées automatiquement : elles demandent toujours une confirmation.

**Sinon** : conflit explicite. Le brouillon reste dans IndexedDB et dans la file. L'interface
liste les gestes concernés, propose « Recharger » (sans perte), puis « Réappliquer » geste par
geste, chacun revalidé par le serveur.

**Tests** :

- **propriété de sûreté** (`fast-check`) : pour des paires de lots générés, si la réapplication est
  acceptée, alors `apply(apply(d, D), L) = apply(apply(d, L), D)` ;
- **propriété de refus** (`fast-check`) : pour toute paire telle que les deux ordres donnent des
  empreintes différentes, ou que l'un des ordres viole une précondition, la réapplication est
  **refusée** ;
- **cas construits où l'ordre change le résultat**, tous refusés :
  - distant `splitAt` à la tête de lecture (lit la structure) + local `trimStart` du segment 1
    (écrit la structure) : refus par la condition 2 ;
  - distant « calque à 2 s de la fin » (lit la durée totale) + local `rippleDelete` : refus par la
    condition 2 ;
  - distant `mergeCaptions(c1, c2)` (lit `c2.text`) + local `editCaptionText(c2)` : refus par la
    condition 2 ;
  - local `moveSegment` + distant `moveSegment` d'un autre segment (identifiants différents, mais
    les deux écrivent l'ordre des segments) : refus par la condition 1 ;
  - même champ, masque, audio, `undo` distant : refus ;
- **contre-épreuves** :
  - retrait de la condition 2 ⇒ la propriété de refus échoue ;
  - retrait de la condition 5 avec une déclaration volontairement incomplète d'une opération de
    test ⇒ la propriété de sûreté échoue.

### 6.4 Sauvegarde côté client et reprise

- File en série, comme en 6c. Lots envoyés à la fin d'un geste ou après 1 s d'inactivité.
- Chaque lot non confirmé est écrit dans **IndexedDB** **avant** son envoi, avec sa tête de base et
  son `requestId`.
- Au rechargement :
  - **même tête** : renvoi avec le **même `requestId`** (aucun doublon) ;
  - **tête différente** : procédure du §6.3.
- Le brouillon n'est supprimé qu'après confirmation du serveur.
- IndexedDB indisponible (navigation privée) : avertissement visible, l'édition reste possible,
  avec seulement la protection de la file en mémoire.

### 6.5 Mémoire éditoriale

Le journal est la future source de la mémoire v2 : il est **capturé** à l'étape 7, **pas
exploité**.

---

## 7. Migrations de base de données

Chaque migration est **nouvelle** (jamais de modification d'une migration publiée), et le verrou
`services/api/src/migrations-lock.test.ts` est mis à jour à chaque fois.

| Migration              | PR  | Contenu                                                                                                                                                                                                                                      |
| ---------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8 `clip_project_edits` | 7b  | Journal (§6.1) ; clé `(project_id, seq)` ; `request_id` unique ; déclencheurs anti-modification et anti-suppression ; table annexe `clip_project_heads (project_id, head_seq, checkpoint_revision)` (aucune modification de `clip_projects`) |
| 9 `derivative_leases`  | 7d  | Baux (`derivative_id`, `holder`, `expires_at`) consultés par le nettoyage                                                                                                                                                                    |
| 10 `media_assets`      | 7j  | Bibliothèque : `sha256` unique, type, format normalisé, dimensions, durée, `rel_path` dans `storage/assets/`, déclaration de droits, date                                                                                                    |

Les documents v1 sont migrés en mémoire à la lecture (§3.1) : **aucune migration SQL** ne réécrit
`clip_project_revisions`.

---

## 8. Découpage en PR et dépendances

### 8.1 Ordre et dépendances

Les PR sont **strictement successives**. Chacune part de `main` à jour, **après la fusion et la
validation** de la précédente. Aucune fusion automatique.

| PR  | Dépend de (fusionnées et validées) | Fournit à la suite                                                                                                                                                             |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7a  | —                                  | Modèle v2, opérations, ensembles lus et écrits, préconditions, `historyState`, scène, géométrie                                                                                |
| 7b  | 7a                                 | Journal, API d'édition, **création de points de contrôle** (`checkpoint(projectId)`), annuler / rétablir côté serveur, conflits (règle symétrique de 7a appliquée sous verrou) |
| 7c  | 7a, **7b**                         | Moteur multi-segments ; **le rendu appelle `checkpoint()` livré et testé en 7b**                                                                                               |
| 7d  | 7a, 7b                             | Proxy, vignettes masquées, baux, protections du §5.2                                                                                                                           |
| 7e  | **7a, 7b, 7c, 7d**                 | Socle de l'éditeur (n'est commencée qu'après la fusion de ces quatre PR)                                                                                                       |
| 7f  | 7e                                 | Timeline et segments                                                                                                                                                           |
| 7g  | 7f                                 | Sous-titres                                                                                                                                                                    |
| 7h  | 7f                                 | Cadrage libre et masques temporels                                                                                                                                             |
| 7i  | 7h                                 | Effets visuels et sonores (`blur_region` après les aplats)                                                                                                                     |
| 7j  | 7i                                 | Bibliothèque, calques, effets sonores                                                                                                                                          |
| 7k  | 7j                                 | Cohérence aperçu / export, performances, documentation                                                                                                                         |

```
7a ─► 7b ─► 7c ─► 7d ─► 7e ─► 7f ─► 7g ─► 7h ─► 7i ─► 7j ─► 7k
```

7c et 7d sont techniquement indépendantes l'une de l'autre, mais restent successives pour garder
une seule PR ouverte à la fois.

### 8.2 Contenu de chaque PR

#### 7a — Modèle v2, opérations et scène (pur, sans interface)

- **Périmètre** :
  - schéma v2, segment `gap`, sémantique du §3.3, migration v1 → v2 (fenêtre conservée) ;
  - catalogue d'opérations (`apply`, `inverse`, ensembles lus et écrits, préconditions,
    invariants) ;
  - `historyState`, règle de réapplication du §6.3 ;
  - `scene.ts`, `geometry.ts` ;
  - `docs/plan-etape-7.md` (ce document).
- **Fichiers** : `packages/timeline/src/{project,time,ops/*,history,scene,geometry}.ts` ;
  `render/layout.ts` réutilise `geometry` ; `package.json` (`fast-check` en version exacte).
- **Acceptation** :
  - `apply(inverse(apply(d, op))) = d` (empreinte canonique) pour chaque opération ;
  - documents v1 migrés avec leur fenêtre d'origine ;
  - arrêt sur image et `gap` conformes au §3.3 ;
  - aucune régression du moteur de la 6b.
- **Tests** :
  - unitaires par opération ;
  - propriétés `fast-check` (invariants, retours en arrière exacts) ;
  - conflits (§6.3) : propriété de sûreté, propriété de refus quand l'ordre change le résultat,
    cas construits dans les deux sens (écritures distantes contre lectures locales, lectures
    distantes contre écritures locales), contre-épreuves ;
  - migration v1 → v2.

#### 7b — Journal d'édition, points de contrôle et API

- **Périmètre** :
  - migration 8 ;
  - `POST/GET /api/clip-projects/:id/edits` (lots, annuler, rétablir) ;
  - `checkpoint()` ;
  - rejeu vérifié ;
  - idempotence ;
  - conflits (§6.3) ;
  - le `PATCH` v1 et la proposition d'effets deviennent des entrées `system`.
- **Fichiers** : `services/api/src/clips/{edits,history,service,repository}.ts`,
  `routes/clips.ts`, `db.ts`, `migrations-lock.test.ts`.
- **Acceptation** :
  - une proposition refusée ⇒ aucune écriture ;
  - une piste non autorisée ⇒ refus, y compris par un « annuler » ;
  - `HISTORY_CHANGED` si la pile a changé ;
  - rejeu identique au document ;
  - deux connexions concurrentes ⇒ un seul gagnant ;
  - un point de contrôle est une révision immuable utilisable par `clip_renders`.
- **Tests** :
  - intégration (SQLite fichier, deux connexions) ;
  - annuler / rétablir après rechargement ;
  - verrou de migration ;
  - contre-épreuves.

#### 7c — Moteur multi-segments

- **Périmètre** :
  - N segments, arrêt sur image (image figée + silence), `gap` (fond + silence) ;
  - fondus de raccord de 8 ms ;
  - plan construit depuis la scène, `-filter_complex_script` ;
  - élargissement de la fenêtre avec nouveau manifeste ;
  - image exacte (sous-titres et zooms compris) ;
  - point de contrôle avant chaque rendu (via 7b).
- **Fichiers** : `packages/render/src/{plan,ffmpeg-args,run,subtitles}.ts`, `render-service.ts`,
  `clips/service.ts` (fenêtre ±60 s pour les nouveaux projets), `config.ts`, `.env.example`
  (`EDITOR_WINDOW_MARGIN_SEC`).
- **Acceptation** :
  - coupes exactes à l'image près ;
  - audio et vidéo synchrones après chaque coupe ;
  - silence mesuré pendant un arrêt sur image et un `gap` ;
  - sous-titres qui suivent les coupes ;
  - aplats présents à chaque instant, arrêts sur image compris ;
  - graphe valide avec 50 segments, sous Windows ;
  - projet de la 6b rendu à l'identique (même empreinte de plan, ou différence documentée).
- **Tests** : intégration FFmpeg (éclairs et bips par segment, Goertzel pour le silence, pixels des
  aplats, 50 segments) ; fixture à piste unique « Tout ».

#### 7d — Médias de travail de l'éditeur

- **Périmètre** :
  - travaux `video_proxy` et `thumbnail_sprite` (vignettes **masquées**) ;
  - service `Range` avec **toutes** les protections du §5.2 (adresse du socket, `Host`, `Origin`,
    `Sec-Fetch-Site`, jeton éphémère, CORS fermé, `Cross-Origin-Resource-Policy`) ;
  - variable `EDITOR_ALLOWED_ORIGINS` (`.env.example`, test existant de documentation) ;
  - baux (migration 9) ;
  - polices servies au navigateur ;
  - avertissement de `doctor` sur `API_HOST`.
- **Fichiers** : `packages/media/src/{proxy,thumbnails}.ts`,
  `services/api/src/clips/{editor-media,media-access}.ts`, `storage/service.ts`, `config.ts`,
  `.env.example`, `scripts/doctor.ts`.
- **Acceptation** :
  - proxy aligné sur le temps source (écart ≤ 1 image) ;
  - chacun des contrôles du §5.2 refuse sa requête interdite, indépendamment des autres ;
  - vignettes sans zone sensible ;
  - nettoyage jamais pendant un bail ;
  - original intact.
- **Tests** :
  - intégration : dérive temporelle, `Range`, pixels des vignettes, bail expiré puis nettoyage ;
  - **sécurité du proxy** (un test par contrôle, avec `app.inject` et l'option `remoteAddress`,
    puis un serveur réel à l'écoute) :
    - connexion depuis une adresse non locale ⇒ 403, **même avec** `X-Forwarded-For: 127.0.0.1`,
      `X-Real-IP` ou `Forwarded: for=127.0.0.1` ;
    - test d'architecture : `trustProxy` désactivé, aucun en-tête de transfert lu par ces routes ;
    - `Host` : `127.0.0.1:5173` et `localhost:5173` acceptés ; `evil.example:5173`,
      `127.0.0.1:4000` (port de l'API) et `127.0.0.1:3000` refusés ; liste des `Host` déduite
      d'`EDITOR_ALLOWED_ORIGINS` (une origine ajoutée ajoute exactement un `Host`) ;
    - demande de jeton : `Origin` **absent** ⇒ 403 ; `Origin` hors liste ou `null` ⇒ 403 ;
      `Content-Type` autre que JSON ⇒ refus ; `Sec-Fetch-Site: cross-site` ou `same-site` ⇒ 403 ;
      `Origin` autorisé et `same-origin` ⇒ jeton délivré ;
    - lecture du média : `Origin` absent **avec** jeton valide et `Sec-Fetch-Site: same-origin`
      ⇒ 206 ; `Origin` absent **sans** jeton ⇒ 403 ; `Origin` absent, jeton valide et
      `Sec-Fetch-Site` absent (navigateur ancien) ⇒ 206 ; `Origin` présent non autorisé ⇒ 403
      **même avec** un jeton valide ; `Sec-Fetch-Site: cross-site` ou `same-site` ⇒ 403 même avec
      un jeton valide ;
    - jeton absent, expiré, falsifié, ou lié à un autre projet ou dérivé ⇒ 403 ;
    - `OPTIONS` ⇒ 403, aucune réponse ne contient `Access-Control-Allow-Origin` ;
    - en-têtes `Cross-Origin-Resource-Policy`, `Cache-Control`, `nosniff`, `Referrer-Policy`
      présents ;
    - jeton absent des journaux du serveur ;
    - `EDITOR_ALLOWED_ORIGINS` contenant une origine non locale ⇒ configuration refusée au
      démarrage ;
  - **intégration réelle à travers le proxy Vite** (Linux, dans le job Playwright de la CI) :
    - l'API de test écoute sur un port éphémère ; un serveur Vite est lancé par programme avec
      `apps/web/vite.config.ts` (même option `changeOrigin: false`), sa cible pointant vers cette
      API ;
    - Chromium ouvre l'interface servie par Vite, demande un jeton par `fetch` POST, puis lit le
      proxy par une vraie balise `<video>` (requêtes `Range` comprises) ⇒ lecture réussie ;
    - assertions sur les en-têtes réellement reçus par l'API : `Host` = celui de Vite, `Origin`
      absent sur le média, aucun en-tête `X-Forwarded-*` ;
    - une page servie par une **autre origine** (autre nom d'hôte local) insère la même balise
      `<video>` et tente la demande de jeton ⇒ les deux sont refusées ;
    - un `Host` étranger envoyé à Vite ⇒ refusé par Vite ; le même `Host` envoyé directement à
      l'API ⇒ refusé par l'API ;
  - **contre-épreuves** : chaque contrôle retiré seul fait échouer son test (y compris
    l'acceptation de `same-site`, et la déduction des `Host` remplacée par une liste élargie au
    port de l'API).

#### 7e — Socle de l'éditeur web

- **Périmètre** :
  - page de l'éditeur (ouverte depuis « Clips ») ;
  - état (`zustand`, version exacte) ;
  - historique (§6.2) ;
  - file, brouillon IndexedDB, plusieurs onglets ;
  - lecteur (horloge, double tampon, canvas avec aplats, Web Audio, pistes autorisées
    seulement) ;
  - transport ;
  - lecture seule ;
  - Playwright et installation de Chromium dans la CI.
- **Fichiers** : `apps/web/src/editor/{store,player}/*`, `EditorPage.tsx`,
  `.github/workflows/ci.yml`, `package.json`.
- **Acceptation** :
  - Ctrl+Z / Ctrl+Maj+Z exacts, y compris après rechargement ;
  - fermeture brutale ⇒ brouillon restauré ;
  - deux onglets : comportements du §6.2 ;
  - conflit sans perte ;
  - pistes non autorisées non lues ;
  - pixels du canvas sous une zone masquée = aplat ;
  - lecture seule stricte.
- **Tests** :
  - historique et file (unitaires) ;
  - horloge avec un média simulé ;
  - composants avec une API simulée ;
  - Playwright (deux onglets, rechargement, brouillon) ;
  - contre-épreuves.

#### 7f — Timeline et segments

- **Périmètre** :
  - pistes, éléments, poignées ;
  - coupe, rognage, allongement, déplacement ;
  - suppression avec et sans décalage ;
  - arrêt sur image ;
  - aimantation, zoom, raccourcis ;
  - formes d'onde et vignettes.
- **Acceptation** : toute action passe par le réducteur ; un geste = une entrée d'historique ;
  aimantation testée ; `gap` et arrêts sur image visibles et conformes au §3.3.
- **Tests** : conversions pixels ↔ ms ; interactions au pointeur (jsdom) ; parcours Playwright avec
  une API simulée.

#### 7g — Sous-titres dans l'éditeur

- **Périmètre** :
  - piste de sous-titres : modification des horaires, découpage et fusion ;
  - texte corrigé ou ajouté manuellement (pseudonymisé) ;
  - style et position par item ;
  - rendu ASS correspondant.
- **Acceptation** : texte d'origine consultable ; pseudonymisation des ajouts ; ASS conforme à
  l'aperçu ; sous-titres figés pendant un arrêt sur image, absents pendant un `gap`.
- **Tests** : unitaires, ASS échappé (injection), intégration FFmpeg.

#### 7h — Cadrage libre et masques temporels

- **Périmètre** :
  - calques personnalisés avec poignées sur le canvas ;
  - surcharge par segment ;
  - masques temporels **opaques**.
- **Acceptation** : une zone masquée n'apparaît dans aucun calque, à aucun instant de sa plage, ni
  dans le canvas ni dans l'export.
- **Tests** : pixels FFmpeg et canvas (Playwright) sur fixture colorée ; géométrie commune.

#### 7i — Effets visuels et sonores

- **Périmètre** :
  - catalogue v2 (`defineEffect`) ;
  - `blur_region` comme effet créatif (§3.4) ;
  - ajout et modification sur la timeline ;
  - automatisation du gain, fondus, `duck`, `bleep`.
- **Acceptation** :
  - paramètres validés ;
  - aucun texte dans le graphe ;
  - effet identique dans l'aperçu et dans l'export ;
  - `blur_region` jamais compté comme un masque, et toujours appliqué après les aplats.
- **Tests** : unitaires par effet ; FFmpeg (pixels, mesure Goertzel du bip et du ducking) ;
  contre-épreuve (flou à la place d'un aplat ⇒ test en échec).

#### 7j — Bibliothèque de médias, calques et effets sonores

- **Périmètre** :
  - import d'**images fixes** (mèmes compris) et de sons dans `storage/assets/` ;
  - validation : ffprobe, limites de taille et de dimensions, SVG et images animées refusés,
    **ré-encodage normalisé** (PNG, WAV) ;
  - empreinte et déduplication ;
  - déclaration de droits ;
  - migration 10 ;
  - pistes Calques et Effets sonores ;
  - rendu `overlay`/`amix`.
- **Acceptation** : fichier malveillant, corrompu ou animé refusé ; chemin jamais exposé ; original
  intact.
- **Tests** : fichiers piégés (polyglottes, dimensions énormes, extension trompeuse, GIF animé) ;
  intégration FFmpeg.

#### 7k — Cohérence aperçu / export et finitions

- **Périmètre** :
  - tests croisés canvas (Playwright) contre image FFmpeg sur des fixtures, avec tolérance ;
  - mesures de performance (clip de 60 s, 50 segments) ;
  - guide `docs/editeur.md`, architecture, compte rendu de l'étape 7.
- **Acceptation** : écart de géométrie ≤ 2 px ; écarts de texte documentés ; budgets de
  performance respectés.

---

## 9. Tests transverses

- Chaque PR :
  - `npm run check` passe ;
  - CI verte, Windows compris ;
  - contre-épreuves sur chaque garde-fou ;
  - aucune vraie vidéo versionnée (fixtures `lavfi`) ;
  - aucun appel à Claude.
- Un projet **à piste unique « Tout »** fait partie des fixtures de chaque PR moteur et éditeur :
  une seule piste audio, consentements et déclaration `mix_composition` exigés, aucune séparation
  inventée.
- Dépendances : versions exactes dans `package.json` et `package-lock.json` ; Chromium installé
  par une étape dédiée de la CI (`npx playwright install --with-deps chromium`), dont la version
  est fixée par celle de Playwright.

---

## 10. Risques et parades

| Risque                                                        | Parade                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saccades aux coupes dans le navigateur                        | Double tampon, proxy à groupe d'images court ; repli « aperçu FFmpeg » toujours disponible                                                                                                                                |
| Dérive audio/vidéo dans l'aperçu                              | Horloge maître audio, recalage de la vidéo au-delà d'un seuil ; tests d'horloge                                                                                                                                           |
| Écart entre l'aperçu et l'export (texte)                      | Scène commune, mêmes polices, mêmes coupures de lignes ; « Image exacte » ; tests croisés en 7k                                                                                                                           |
| Fuite d'une zone sensible par le proxy non masqué             | Aplats dessinés à chaque image du canvas ; vignettes masquées ; jamais exporté ; tests de pixels                                                                                                                          |
| Accès au proxy depuis une autre machine ou une page intersite | Adresse réelle du socket (aucun en-tête de transfert), `Host`, `Origin` en liste blanche, `Sec-Fetch-Site`, jeton éphémère signé, CORS fermé, `Cross-Origin-Resource-Policy` ; un test et une contre-épreuve par contrôle |
| Réapplication dont le résultat dépend de l'ordre              | Vérification dans les deux sens, préconditions dans les deux ordres, comparaison des deux empreintes ; propriété de refus `fast-check`                                                                                    |
| Flou pris pour une protection                                 | `blur_region` séparé des masques dans le modèle, l'interface et le rendu ; appliqué après les aplats ; contre-épreuve                                                                                                     |
| Réapplication erronée après un conflit                        | Ensembles lus et écrits, préconditions, invariants ; masques et audio jamais réappliqués automatiquement ; propriétés `fast-check`                                                                                        |
| Annulation imprévisible avec plusieurs onglets                | Historique linéaire par projet, libellé de la source, `HISTORY_CHANGED`                                                                                                                                                   |
| Graphe FFmpeg trop long ou complexe                           | Fichier de script ; test avec 50 segments ; limites du schéma                                                                                                                                                             |
| Volume de persistance                                         | Journal + points de contrôle ; un geste = un lot                                                                                                                                                                          |
| Divergence entre client et serveur                            | Réducteur partagé ; empreinte comparée à chaque lot et au rejeu                                                                                                                                                           |
| Médias importés malveillants                                  | Ré-encodage systématique, SVG et animations refusés, limites, jamais d'exécution                                                                                                                                          |
| Droits d'auteur (mèmes, sons)                                 | Déclaration à l'import, rappel dans l'interface, bibliothèque locale uniquement                                                                                                                                           |
| Fenêtre élargie sans contrôle d'intégrité                     | Nouveau manifeste obligatoire, vérifié avant chaque rendu ; anciens projets non élargis automatiquement                                                                                                                   |
| Dérive du périmètre                                           | PR fermées ; hors périmètre listé au §1 (décision 4)                                                                                                                                                                      |

---

## 11. Vidéos Twitch ou à piste audio unique mixée : étape 8 séparée

**Ce qui ne sera pas fait** : séparer automatiquement les sources audio. Ce n'est pas fiable, et
les voix de tiers resteraient dans la piste.

**Ce qui fonctionne déjà** (vérifié dans le code) :

- piste unique → rôle `mix` ;
- transcription et montage repliés sur le mix ;
- accords et déclarations « Tout » applicables tels quels (`mix_composition`) ;
- intégrité MP4 avec repli sur le fichier entier.

**Prise en charge à l'étape 7** (sans rien ajouter à l'import) :

- une seule piste audio « Tout » dans l'éditeur, avec un gain global ;
- pas de réglage séparé du jeu, de la voix ou de Discord, et pas d'atténuation automatique du jeu
  sous la voix ;
- l'éditeur l'indique explicitement ;
- effets sonores ajoutés possibles ;
- sous-titres attribués à « Tout » ;
- export soumis à la déclaration de composition et aux accords existants ;
- fixtures dédiées dans les tests (§9).

**Ce que demanderait l'étape 8 :**

- parcours d'import depuis l'interface ;
- champ `source_kind` (`obs_multitrack` / `single_mix`) sur l'enregistrement (nouvelle
  migration) ;
- `.ts` Twitch : copie remuxée dans `processing/` (l'original n'est jamais touché), intégrité
  vérifiée sur l'original ;
- détection des passages coupés par Twitch (silences dus au DMCA), signalés comme avertissements ;
- déclaration obligatoire de la composition dès l'import, avec catégories à confirmer (alertes,
  voix de synthèse lisant des messages de spectateurs) ;
- profil de masques pour l'habillage du stream (chat, pseudos à l'écran).

---

## 12. Conformité aux règles de l'étape 6

Vérifiée contre `docs/plan-etape-6.md` (§6.4, §6.5, §7.2, §14) et le code de `main`.

| Règle de l'étape 6                                                                                                                                                                                                   | Application à l'étape 7                                                                                                                                                                                 | Statut                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Consentements audio : micro, Discord, jeu et « Tout » soumis aux déclarations et accords par catégorie ; un accord Discord seul n'autorise jamais « Tout » ; aucune superposition de « Tout » et des pistes séparées | `allowedAudio` inchangé et revérifié à chaque lot, à chaque annuler / rétablir, à chaque aperçu et export ; écoute limitée aux pistes autorisées ; opérations audio jamais réappliquées automatiquement | Conforme                        |
| Sous-titres soumis aux mêmes règles ; pseudonymisation ; transcription intacte                                                                                                                                       | Sous-titres manuels pseudonymisés ; items de transcription immuables ; corrections tracées                                                                                                              | Conforme                        |
| Masquage **opaque** avant tout recadrage ; désactivation avec confirmation et avertissement                                                                                                                          | Masques globaux et temporels opaques uniquement ; `blur_region` jamais considéré comme une protection ; aplats dans le canvas, les vignettes et l'export                                                | Conforme (ajustement A intégré) |
| Intégrité réelle de la source avant chaque rendu ; manifestes figés                                                                                                                                                  | Fenêtre conservée pour les projets existants ; toute extension crée un nouveau manifeste ; segments vérifiés dans la fenêtre du manifeste référencé                                                     | Conforme                        |
| Original jamais modifié                                                                                                                                                                                              | Source lue en `-i` ; proxy, vignettes et pistes dans `processing/` ; médias importés ré-encodés dans `storage/assets/`                                                                                  | Conforme                        |
| Révisions immuables, publication sous verrou, récupération                                                                                                                                                           | Révisions = points de contrôle immuables ; journal en ajout seul ; publication et récupération inchangées                                                                                               | Conforme                        |
| Décision effective recalculée côté serveur                                                                                                                                                                           | Garde appliquée à chaque lot, annuler, rétablir et rendu ; lecture seule sinon                                                                                                                          | Conforme                        |
| Aucune publication, aucun appel à Claude dans le rendu                                                                                                                                                               | Inchangé                                                                                                                                                                                                | Conforme                        |
| Migrations publiées jamais modifiées                                                                                                                                                                                 | Migrations 8, 9 et 10 nouvelles ; v1 → v2 du document en mémoire                                                                                                                                        | Conforme                        |
| Durée 5–180 s, confirmation hors plage                                                                                                                                                                               | Invariant du réducteur ; confirmation liée à la révision, comme en 6a                                                                                                                                   | Conforme                        |

**Point de vigilance** : la **fenêtre ±60 s** dépasse la fenêtre ±10 s de l'étape 6
(décision 7). Ce n'est pas une contradiction : la décision 3 la remplace pour les **nouveaux**
projets, les anciens conservent ±10 s, et l'intégrité reste vérifiée sur la fenêtre réellement
couverte. En revanche, l'**ajustement des bornes calé sur les mots** et les **alertes contexte /
réaction** de la 6a s'appliquent toujours au premier et au dernier segment.

---

## 13. Avancement

| PR                                                | Statut                                                         |
| ------------------------------------------------- | -------------------------------------------------------------- |
| 7a — Modèle v2, opérations et scène               | fusionnée (PR #18)                                             |
| 7b — Journal d'édition, points de contrôle et API | fusionnée (PR #19)                                             |
| 7c — Moteur multi-segments                        | en revue                                                       |
| 7d à 7k                                           | non commencées (chacune attend la validation de la précédente) |

---

## 14. Écarts et précisions de mise en œuvre (PR 7a)

Précisions apportées pendant la PR 7a, sans changer les décisions du § 1 :

- **Type de retour exact d'`editToSource`** (`packages/timeline/src/time.ts`) :
  - `{ kind: 'source', srcMs, segmentId, frozen }` dans un segment source ou pendant un arrêt sur
    image (`frozen: true`, `srcMs` = image figée) ;
  - `{ kind: 'gap', segmentId }` dans un vide : aucun temps source n'y correspond ;
  - `null` **uniquement** hors du clip (`t < 0` ou `t ≥ durée totale`).

  Le compilateur oblige chaque appelant à traiter les trois cas.

- **Schéma v1 inchangé** : `SegmentSchema` (v1) n'accepte toujours pas de vide ; le segment `gap`
  n'existe que dans le schéma v2 (`SegmentV2Schema`), où la vitesse est fixée à 1.
- **Documents stockés** : la PR 7a fournit le schéma v2, la migration et les opérations, **sans
  changer ce que le serveur stocke ni rend** (toujours la v1 de l'étape 6). Le passage du serveur à
  la v2 se fait avec le journal (7b) et le moteur multi-segments (7c).
- **Migration v1 → v2** (`migrateV1ToV2(doc, { manifestWindow })`) :
  - la fenêtre éditable est celle du manifeste existant, fournie par l'appelant ;
  - les masques v1, sans identifiant, reçoivent `mask-000`, `mask-001`… dans leur ordre d'origine ;
  - les items de sous-titres sont rangés dans l'ordre canonique (début, identifiant). Aucun effet
    visible : l'affichage, l'ASS et le SRT trient déjà par instant.
- **Granularité des clés d'état** (`keys.ts`) : la structure des segments est **une seule clé**
  (`segments`). Toute modification de segment change les positions en temps montage des
  suivants : une granularité plus fine n'apporterait rien et affaiblirait la sûreté.
- **Inverse** : une opération `restore` générique remet les clés écrites à leur valeur d'avant, à
  condition qu'elles aient encore la valeur produite (sinon `PRECONDITION_FAILED`). Elle est
  correcte par construction pour toutes les opérations, et l'autorisation audio y est revérifiée
  (annuler ne réactive jamais une piste dont l'accord a été révoqué). Les opérations du journal
  restent sémantiques (`splitSegment`, `editCaptionText`…), seules les inverses sont des
  restaurations.
- **Noms des opérations** (§4) : `trimStart/End` → `trimSegment` ; `setMask` / `addTimedMask` →
  `setEntity` (collection `mask`) ; ajout, modification et retrait d'effets, calques, effets
  sonores, sous-titres manuels et surcharges de disposition → `setEntity` / `removeEntity`.
  `setGain` et `setAutomation` → `setTrack`.
- **Exemples de conflits du § 6.3** : avec les lectures et écritures réellement déclarées,
  certains exemples sont refusés par la condition 1 plutôt que par la condition 2 :
  - `splitSegment` distant contre `trimSegment` local : condition 1 (les deux écrivent la
    structure) ;
  - `mergeCaptions` distant contre `editCaptionText` local : condition 1 (la fusion écrit aussi le
    second item).

  Les exemples propres à la condition 2 sont testés :
  - calque ancré « 2 s avant la fin » (distant) contre rognage (local) : les deux ordres donnent
    le **même** document, seule la condition 2 refuse ;
  - surcharge de disposition (distant) contre déplacement de segment (local).

- **Condition 5 (comparaison des deux ordres)** : retirée seule, elle ne fait échouer aucun test.
  Les conditions 1 et 2 refusent déjà tous les cas dépendants de l'ordre, parce que les lectures
  déclarées sont complètes (propriété `fast-check` « lectures complètes »). Elle reste un filet de
  sécurité. Les tests ne sont pas vides : retirer ensemble les conditions 1, 2 et 5 (ne garder que
  la différence d'identifiants) fait échouer 5 tests, dont la propriété de refus.
- **Identifiants** : uniques **dans** chaque collection (masques, effets, calques, effets
  sonores) ; les sous-titres manuels partagent l'espace des items de transcription (lecture
  déclarée des deux côtés).
- **Sous-titres** :
  - horaires d'affichage limités à ±2 s autour des mots de l'item ;
  - découpage et fusion refusés tant qu'une correction ou un réglage d'affichage existe sur
    l'item (`PRECONDITION_FAILED`, « annulez d'abord ») ;
  - la fusion exige la même source et des items consécutifs.
- **Mode fidèle** : les effets de mouvement (`punch_zoom`, `reaction_hold`, `zoom`, `shake`,
  `flash`) sont inactifs, comme les zooms à l'étape 6 ; `caption_emphasis`, `blur_region` et les
  effets audio restent actifs.
- **Géométrie partagée** : `presetGeometry` / `presetLayers` (`packages/timeline/src/geometry.ts`)
  remplacent le calcul interne de `@acs/render` ; un test de propriété vérifie que les recadrages
  du graphe FFmpeg sont exactement ceux de la géométrie partagée, et que `toPixelRect` est
  identique à celui de `@acs/media`.
- **Dépendances** : `fast-check` était déjà présent (`^4.11.0`) ; il est verrouillé en version
  exacte (`4.11.0`). `zustand` et Playwright arrivent avec la PR 7e, comme prévu.

**Corrections de la revue de la PR 7a** :

- **Suppression d'un masque** (`removeEntity`, collection `mask`) : exige `acknowledgeMaskRisk: true`,
  comme sa désactivation. Même règle pour une **annulation** qui retirerait ou désactiverait un
  masque opaque (annuler l'ajout d'un masque, par exemple) : l'interface devra demander la
  confirmation. Annuler une suppression ou une désactivation (protection rétablie) n'en demande
  pas.
- **Autorisations explicites de la scène** : `SceneOptions.allowedAudioIndexes` et
  `SceneOptions.allowedCaptionRoles` sont **obligatoires**. Une liste vide n'autorise rien ; aucune
  piste ni source n'est autorisée par défaut. Les sous-titres affichés sont les sources choisies
  **et** autorisées aujourd'hui : une source révoquée (Discord) n'apparaît plus, même si le
  document la contient encore. Les sous-titres manuels, écrits par le créateur, ne dépendent
  d'aucune source audio.
- **Arrêt sur image et cadrage** : `insertFreeze` reporte la surcharge de disposition du segment sur
  l'arrêt et sur la partie après (les trois parties gardent le même cadrage).
- **`sourceAudible`** : vrai seulement si au moins une piste autorisée et activée est effectivement
  jouée (faux après révocation, retrait de la piste, ou sans piste).

## 15. Précisions de mise en œuvre (PR 7b)

- **Transition jusqu'aux PR 7c et 7e (décision du créateur : projection v1 exacte)** :
  - le document courant est désormais un document v2 (point de contrôle + journal) ;
  - l'interface 6c, le `PATCH` v1, la proposition d'effets et le moteur de l'étape 6 lisent sa
    **projection v1 exacte** (`projectToV1`) : elle n'existe que si l'aller-retour v2 → v1 → v2 est
    sans perte ;
  - si le document utilise une fonction de l'éditeur (vide, calque, masque temporel, sous-titre
    manuel, automatisation, disposition personnalisée, fond…), ces chemins répondent
    `409 EDITOR_REQUIRED` avec un message explicite ; le document reste lisible par
    `GET /api/clip-projects/:id/document`, et rien n'est jamais projeté approximativement.
- **Version d'un projet** : numéro de la dernière entrée du journal (les projets existants
  continuent à partir de leur révision courante). C'est la valeur `revision` renvoyée par l'API
  6c et attendue comme `baseRevision` par le `PATCH` : l'interface 6c fonctionne sans changement.
- **Points de contrôle** : révision immuable (schéma v2) dont le numéro est la version
  qu'elle fige (`request_id = checkpoint-<version>`). Créés avant chaque demande de rendu, tous les
  200 lots, ou à la demande ; idempotents. `GET /revisions` liste les **versions** (révisions
  d'origine puis entrées du journal), sans doublon pour les points de contrôle.
- **PATCH v1 et proposition d'effets** : transformés par les règles de l'étape 6 sur la projection
  v1, puis enregistrés comme entrée `system` du journal sous forme d'une restauration clé par clé
  vérifiée (`diffToRestore`). Ils sont annulables depuis l'éditeur comme les autres entrées. La
  confirmation de désactivation d'un masque est transmise telle quelle.
- **Rendu** : la demande crée d'abord un point de contrôle. Dans la transaction d'insertion
  (`BEGIN IMMEDIATE`), **avant toute réutilisation ou création**, la version du plan doit égaler la
  **version courante** du journal ; sinon `VERSION_CONFLICT` immédiat, rien n'est mis en file ni
  écrit. L'existence de la révision du plan ne suffit pas : une révision antérieure reste en base
  après une modification concurrente. Si la version courante n'a pas de révision immuable (projet
  modifié entre le point de contrôle et la construction du plan), même refus. La publication et la
  récupération comparent aussi la version courante du journal.
- **Empreinte attendue** (`expectedHash`) : comparée seulement quand le lot est construit sur la
  version courante. Un lot réappliqué (`rebased: true`) renvoie la nouvelle empreinte, que
  l'interface doit reprendre.
- **Rejeu** : chaque empreinte d'entrée est vérifiée ; un écart donne `JOURNAL_CORRUPTED`, sans
  aucune correction. Le journal est protégé par des déclencheurs (aucune modification ni
  suppression, sauf suppression du projet en cascade).
- **Nouveaux codes d'erreur** : `EDITOR_REQUIRED` (409), `HISTORY_CHANGED` (409),
  `PRECONDITION_FAILED` (409), `DOCUMENT_DIVERGED` (409), `MASK_RISK_NOT_ACKNOWLEDGED` (422),
  `JOURNAL_CORRUPTED` (500).
- **Tests existants adaptés au nouveau stockage** (sans changer ce qu'ils vérifient) : le test de la
  migration 7 l'applique seule (`MIGRATIONS.slice(0, 7)`) ; le test 6c « révisions antérieures
  intactes » lit l'empreinte de la version par l'API au lieu de la table des révisions.
- **API ajoutée** :

  | Méthode | Route                                 | Rôle                                                         |
  | ------- | ------------------------------------- | ------------------------------------------------------------ |
  | GET     | `/api/clip-projects/:id/document`     | Document v2, version, empreinte, historique (haut des piles) |
  | POST    | `/api/clip-projects/:id/edits`        | Lot (`do`), annulation (`undo`), rétablissement (`redo`)     |
  | GET     | `/api/clip-projects/:id/edits?since=` | Entrées après une version (synchronisation entre onglets)    |

## 16. Précisions de mise en œuvre (PR 7c)

- **Le moteur rend le document v2** (version courante du journal), et non plus la projection v1 :
  un montage de l'éditeur (coupes, arrêts sur image, vides) est rendu même si l'interface 6c ne
  peut pas l'afficher (`EDITOR_REQUIRED` côté 6c seulement).
- **Fonctions de l'éditeur pas encore rendues : refus explicite**, jamais ignorées
  (`409 RENDER_FEATURE_UNSUPPORTED`, liste des fonctions en cause) : disposition personnalisée et
  masques temporels (7h), réglages par sous-titre et sous-titres manuels (7g), effets du catalogue
  v2 autres que ceux de l'étape 6 et automatisation du gain (7i), calques et effets sonores (7j).
  Un effet désactivé, ou un effet de mouvement en mode fidèle, n'est pas appliqué et n'est donc pas
  refusé. Même règle pour l'image exacte.
- **Une entrée FFmpeg par segment** (même fichier, recherche précise `-ss`, lecture bornée
  `-t` + 250 ms), au lieu d'une entrée unique découpée : réordonner les segments ne met aucune image
  en mémoire tampon, et la mémoire ne dépend pas de l'ordre. Un vide n'a pas d'entrée.
- **Coupes sur la grille d'images de sortie** : la première image d'un segment est celle dont
  l'instant est le premier ≥ son début en temps montage ; le nombre d'images d'un segment est la
  différence de ces indices. Le total vaut toujours les images de la durée totale : aucune dérive,
  quel que soit le nombre de coupes (fréquence non entière comprise). L'audio est coupé à
  l'échantillon près (48 échantillons par milliseconde) ; l'écart image / son à une coupe reste
  inférieur à une image et ne se cumule pas.
- **Image source de début d'un segment** (recherche précise de FFmpeg) : quand l'instant source
  tombe entre deux images, FFmpeg < 7 prend celle qui le couvre et FFmpeg ≥ 7 la suivante ; les deux
  sont à l'image près, et identiques quand l'instant tombe sur une image. Même règle pour l'image
  figée d'un arrêt sur image, et pour l'image exacte (même version, même choix que le rendu). Les
  horodatages de chaque branche sont remis à zéro AVANT la cadence (`fps`) : sans cela, FFmpeg
  récent répétait ou sautait des images (constaté sur la CI Windows, corrigé et testé). Lire avant
  l'instant pour couper dans le graphe a été écarté : la lecture pourrait sortir de la zone protégée
  par le manifeste, et l'origine des horodatages diffère elle aussi selon les versions.
- **Arrêt sur image** : une image (aplats compris) répétée, **silence numérique** (`anullsrc`) sur
  chaque piste. **Vide** : fond de la mise en page (`layout.background`, aucune image source),
  silence numérique. Les zooms de la facecam sont exprimés dans le temps de chaque branche.
- **Raccords** : fondu de 8 ms à la sortie du segment qui précède et à l'entrée de celui qui suit,
  **aux seuls raccords** : ni au début ni à la fin du clip (comportement de l'étape 6 inchangé ;
  c'est aussi ce qui garantit des plans identiques pour un segment).
- **Concaténations vidéo et audio séparées** (une par piste) : chaque flux garde sa durée exacte
  (le `concat` commun complète les segments au plus long flux, ce qui ferait dériver le son).
- **Graphe lu depuis un fichier** (`graph.txt` du dossier de travail) : `-/filter_complex` avec
  FFmpeg ≥ 7, `-filter_complex_script` avant. L'option est choisie par un **essai réel** de
  l'exécutable (source synthétique), mémorisé par chemin. La CI couvre les deux : Linux (FFmpeg
  6.1, option historique) et Windows (FFmpeg récent).
- **Projets de l'étape 6 rendus à l'identique** : un clip d'un seul segment source garde le graphe
  de l'étape 6, et le plan est identique octet pour octet (12 projets de référence, empreintes
  capturées avec le moteur 6b sur `main` avant la PR, vérifiées par l'entrée v1 et par le document
  v2 migré). `RENDER_ENGINE_VERSION` reste à 1 : les rendus existants restent reconnus à jour. Le
  champ `frameGraph` du plan est conservé pour cette raison ; l'image exacte utilise désormais un
  plan dédié (`buildFramePlan`).
- **Image exacte** (`GET /frame`) : même source, aplats, disposition, zooms et sous-titres que
  l'export (image horodatée à l'instant de sortie, image figée pendant un arrêt sur image, fond
  pendant un vide). Test : moins de 0,2 % de points différents de l'image du rendu au même instant ;
  sans zoom ou sans sous-titres, l'écart monte à 3,3 % et 0,7 % (contre-épreuves).
- **Fenêtre éditable des nouveaux projets** : proposition ± `EDITOR_WINDOW_MARGIN_SEC` (60 s par
  défaut, 10 à 600 s, bornée à l'enregistrement), couverte par le manifeste créé avec le projet ;
  les sous-titres sont préparés sur toute cette fenêtre. Les projets existants gardent la leur.
  L'ajustement des bornes de l'interface 6c reste limité à ±10 s.
- **Élargissement de la fenêtre** : `POST /api/clip-projects/:id/window`
  (`{ requestId, baseRevision, srcStartMs, srcEndMs }`). Le serveur construit un **nouveau**
  manifeste (empreinte du fichier vérifiée avant et après), puis enregistre sous le verrou une
  entrée `system` du journal : nouvelle fenêtre et sous-titres de la transcription pour la zone
  ajoutée (identifiants propres à la version). Idempotent (`IDEMPOTENCY_MISMATCH` si le contenu
  change), annulable (refusé si un segment est sorti de l'ancienne fenêtre), limité à 20 minutes.
  **Un lot de l'interface ne peut ni élargir ni restaurer la fenêtre** (`extendWindow`, ou
  `restore` de la clé `window`) : il pourrait sinon désigner un manifeste quelconque.
- **Contrôle avant chaque rendu et image exacte** : le manifeste de la fenêtre doit appartenir au
  même enregistrement et couvrir la fenêtre et tous les segments ; puis vérification de l'intégrité
  de la source, comme à l'étape 6.
- **Piste unique « Tout »** : une seule piste (rôle `mix`), autorisée seulement par la déclaration
  de composition ; silence pendant les arrêts sur image ; aucune séparation inventée (test FFmpeg
  du moteur). Le scénario d'analyse simulé de l'API ne produit pas de proposition sur une piste
  mélangée : ce cas est testé au niveau du moteur.
- **Code d'erreur ajouté** : `RENDER_FEATURE_UNSUPPORTED` (409, détails renvoyés).
