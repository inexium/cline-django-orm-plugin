# cline-django-orm-plugin

Plugin [Cline](https://cline.bot) pour l'ORM Django, construit sur le SDK Cline (`AgentPlugin`, testé avec `@cline/core` 0.2.0).

Il réunit dans un seul plugin :

- **un serveur MCP** : le plugin lance le serveur Python `django-orm-mcp` dans le virtualenv du projet, avec les settings Django du projet, pour accéder à la base de **développement locale** (le serveur Python est un projet séparé, voir [`docs/MCP_CONTRACT.md`](docs/MCP_CONTRACT.md)) ;
- **des tools côté plugin**, qui fonctionnent sans base de données ;
- **des règles** injectées dans le prompt système, **des commandes slash** et **des hooks**.

## Contenu

### Serveur MCP (`registerMcpServer`)

Détection automatique :

| Élément | Ordre de recherche |
|---|---|
| projet Django | `projectRoot` du fichier de config, sinon `manage.py` à la racine puis jusqu'à 2 niveaux en dessous |
| interpréteur | `python` du fichier de config, sinon `.venv`, `venv`, `env`, `.env` (dans le projet puis à la racine), sinon `$VIRTUAL_ENV`, sinon `python3` |
| settings | `settingsModule` du fichier de config, sinon `$DJANGO_SETTINGS_MODULE`, sinon `os.environ.setdefault(...)` dans `manage.py` |

Commande lancée par défaut : `<python> manage.py mcp_serve` (stdio). Les réglages de sécurité sont transmis par variables d'environnement (voir le contrat). Les outils MCP apparaissent dans Cline sous la forme `django_orm__<outil>`.

### Tools du plugin (`registerTool`)

| Tool | Rôle |
|---|---|
| `django_env_check` | diagnostic : `manage.py`, venv, settings, versions de Django / DRF / `mcp` / `django-orm-mcp`, enregistrement MCP, sécurité |
| `django_scan_n_plus_one` | analyse statique des N+1 et des usages inefficaces de l'ORM dans les vues, services, serializers DRF, admin et templates |
| `django_model_relations` | relations des modèles (FK, O2O, M2M, `related_name`, accesseurs inverses) avec le `select_related` / `prefetch_related` à utiliser ; diagramme Mermaid en option |
| `django_query_count_test` | génère un test de non-régression `assertNumQueries` (Django) ou `django_assert_num_queries` (pytest-django) |

Règles détectées par `django_scan_n_plus_one` : accès FK dans une boucle (y compris les compréhensions), related manager dans une boucle, filtrage d'une relation déjà préchargée (cache contourné), `get` / `filter` / `create` / `save()` / `delete()` dans une boucle, méthodes `get_<champ>(self, obj)` de serializer et colonnes d'admin, serializers imbriqués, `source="a.b"`, `len(qs)`, `count()` utilisé pour tester l'existence, test de vérité sur un queryset, `list(qs)[0]`, boucles `{% for %}` des templates.

L'analyse tient compte des `select_related` / `prefetch_related` présents sur le queryset parcouru, ou sur ses affectations dans la même fonction. Elle s'appuie aussi sur un index des modèles construit à partir des `models.py`. Chaque résultat porte un niveau de confiance (`low` / `medium` / `high`). Ce sont des heuristiques, à confirmer avec les outils MCP de capture des requêtes.

### Règles (`registerRule`)

- `django-orm-safety` : base locale uniquement, écritures et exécution de code selon la configuration, pas de secrets ;
- `django-orm-performance` : conventions `select_related` / `prefetch_related` / `annotate` / `exists` / `bulk_*` et vérification après chaque modification ;
- `django-orm-mcp-tools` : mode d'emploi des outils MCP (active seulement si ces outils sont disponibles).

### Commandes slash (`registerCommand`)

| Commande | Rôle |
|---|---|
| `/django-doctor` | vérifier l'installation |
| `/n-plus-one-audit [chemin]` | audit statique, puis confirmation dynamique et classement par impact |
| `/optimize-view <vue ou URL>` | mesurer, corriger, re-mesurer, ajouter un test de nombre de requêtes |
| `/explain-queryset <expr>` | SQL, plan d'exécution, index possibles |
| `/django-schema [Modèle]` | description des modèles et diagramme |
| `/index-advisor [Modèle]` | index manquants ou inutilisés |

### Hooks

- `beforeTool` : garde-fou sur les outils MCP `django_orm__*`. `dry_run` est forcé sur les écritures, les outils qui exécutent du code sont bloqués s'ils ne sont pas autorisés, et `raw_sql` est refusé s'il n'est pas en lecture seule.
- `afterTool` : après chaque `editor` / `apply_patch` sur un fichier Python ou un template, l'analyse N+1 tourne sur les fichiers modifiés, et les nouveaux résultats sont ajoutés au contexte du modèle. L'index des modèles est recalculé quand un `models.py` change.

## Installation

Prérequis : Node.js 22 ou plus, et un hôte Cline qui charge les plugins du SDK (le CLI, par exemple). Côté Python : `django-orm-mcp`, à développer séparément.

```bash
npm install
```

```bash
npm run build
```

Ensuite, copiez ou liez le dossier du plugin (`package.json` et `dist/`) dans :

- `<projet>/.cline/plugins/django-orm/` pour un seul projet ;
- ou le dossier `plugins` global de Cline, ou encore passez-le avec `--plugin-dir`.

Cline lit le champ `cline.plugins` du `package.json` (`./dist/index.js`). Le plugin n'a aucune dépendance à l'exécution.

## Configuration (optionnelle)

Fichier `.cline/django-orm.json` à la racine du workspace. Voir l'exemple complet dans [`docs/django-orm.example.json`](docs/django-orm.example.json).

| Clé | Défaut | Rôle |
|---|---|---|
| `projectRoot` | détecté | dossier contenant `manage.py` |
| `python` | détecté | interpréteur du virtualenv |
| `settingsModule` | détecté | `DJANGO_SETTINGS_MODULE` |
| `database` | `default` | alias de base de données |
| `mcp.enabled` | `true` | enregistrer le serveur MCP |
| `mcp.serverName` | `django_orm` | préfixe des outils MCP |
| `mcp.command` | `<python> manage.py mcp_serve` | commande complète (`uv run ...`, `poetry run ...`, Docker...) |
| `mcp.url` / `mcp.transport` | — | se connecter à un serveur déjà lancé (`streamableHttp` ou `sse`) |
| `mcp.env` | `{}` | variables supplémentaires (elles ne peuvent pas assouplir les réglages de sécurité) |
| `safety.readOnly` | `true` | lecture seule |
| `safety.allowWrites` | `false` | autoriser les écritures réelles (ignoré si `readOnly`) |
| `safety.allowCodeExecution` | `false` | autoriser `run_queryset`, `capture_queries`, `compare_querysets` |
| `safety.allowNonLocalDb` | `false` | autoriser une base non locale ou `DEBUG=False` |
| `safety.maxRows` | `200` | nombre maximal de lignes renvoyées |
| `safety.statementTimeoutMs` | `5000` | timeout SQL |
| `safety.maskedFields` | `password, token, secret, ...` | champs masqués (ajoutés à la liste par défaut) |
| `analysis.autoScanOnEdit` | `true` | analyse N+1 après chaque modification |
| `analysis.excludeDirs` | — | dossiers à ignorer en plus de `migrations`, `node_modules`, venvs... |
| `analysis.maxFiles` | `2000` | limite de fichiers analysés |

## Développement

```bash
npm test
```

```bash
npm run typecheck
```

`test/fixtures/blog-project` est un mini-projet Django avec des N+1 volontaires (vue, serializer, admin, template), et une vue optimisée qui ne doit produire aucun résultat.

Les types du SDK sont recopiés dans `src/sdk-types.ts`. En 0.2.0, les déclarations publiées de `@cline/sdk` ne se compilent pas (`@cline/agents` importe des noms que `@cline/shared` n'exporte pas), ce qui donne des types `any`. Il faudra les revérifier lors d'une mise à jour du SDK.

## Feuille de route

- serveur Python `django-orm-mcp` ([contrat](docs/MCP_CONTRACT.md)) ;
- analyse statique plus précise (AST Python via l'interpréteur du projet) ;
- skills (`SKILL.md`) pour les workflows d'audit ;
- vérification du chargement dans les extensions VS Code / JetBrains une fois leur migration vers le SDK terminée.
