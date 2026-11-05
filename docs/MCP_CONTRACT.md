# Contrat du serveur MCP Python (`django-orm-mcp`)

Ce document décrit ce que le plugin Cline (TypeScript) attend du serveur MCP Python.
Le plugin **lance** ce serveur et **filtre** certains appels, mais toute la logique
Django (ORM, base de données, capture des requêtes) vit côté Python.

Les noms ci-dessous sont définis dans `src/constants.ts` : toute modification doit être
faite des deux côtés.

## 1. Démarrage

Par défaut, le plugin enregistre ce serveur MCP (transport **stdio**) :

```
<python du venv> manage.py mcp_serve        # cwd = dossier contenant manage.py
```

Le paquet Python doit donc fournir :

- une app Django (à ajouter dans `INSTALLED_APPS`) avec la commande de gestion `mcp_serve` ;
- `importlib.metadata.version("django-orm-mcp")` doit répondre (le plugin s'en sert pour
  son diagnostic `django_env_check`) ; à défaut, le module `django_orm_mcp` doit être importable.

Alternatives configurables dans `.cline/django-orm.json` :

- `mcp.command` : commande complète (ex. `["uv", "run", "python", "manage.py", "mcp_serve"]`) ;
- `mcp.url` (+ `mcp.transport` = `streamableHttp` | `sse`) : serveur déjà lancé, ex. `python manage.py mcp_serve --http 127.0.0.1:8765`.

Nom du serveur : `django_orm` (configurable via `mcp.serverName`). Cline expose chaque outil au
modèle sous le nom `django_orm__<outil>` : garder des noms d'outils courts (64 caractères max au total).

## 2. Variables d'environnement transmises

| Variable | Valeur | Attendu côté serveur |
|---|---|---|
| `DJANGO_SETTINGS_MODULE` | détecté depuis `manage.py` ou configuré | utilisé par `django.setup()` |
| `DJANGO_ORM_MCP_READ_ONLY` | `1` / `0` (défaut `1`) | toute requête dans une transaction annulée ; `SET TRANSACTION READ ONLY` sur PostgreSQL |
| `DJANGO_ORM_MCP_ALLOW_WRITES` | `1` / `0` (défaut `0`) | si `0`, les outils d'écriture ne font qu'un dry-run |
| `DJANGO_ORM_MCP_ALLOW_CODE_EXECUTION` | `1` / `0` (défaut `0`) | si `0`, refuser `run_queryset`, `capture_queries`, `compare_querysets` |
| `DJANGO_ORM_MCP_ALLOW_NON_LOCAL_DB` | `1` / `0` (défaut `0`) | si `0`, refuser de démarrer quand `DEBUG=False` ou quand l'hôte de la base n'est pas local |
| `DJANGO_ORM_MCP_MAX_ROWS` | entier (défaut `200`) | tronquer les résultats |
| `DJANGO_ORM_MCP_STATEMENT_TIMEOUT_MS` | entier (défaut `5000`) | `statement_timeout` (PostgreSQL) / équivalent |
| `DJANGO_ORM_MCP_MASKED_FIELDS` | liste séparée par des virgules | masquer les champs dont le nom contient l'un de ces mots |
| `DJANGO_ORM_MCP_DATABASE` | alias (optionnel) | alias de `DATABASES` à utiliser (défaut `default`) |

Le plugin applique déjà certaines de ces règles côté client (voir §4), mais **le serveur doit
les appliquer lui aussi** : il peut être utilisé par un autre client MCP que Cline.

## 3. Outils attendus

Les paramètres sont indicatifs ; seuls les noms d'outils et les paramètres marqués **(contrat)**
sont lus par le plugin.

### Introspection
| Outil | Rôle |
|---|---|
| `list_models` | apps et modèles, nombre de lignes approximatif |
| `describe_model` | champs, relations (directes et inverses), index, contraintes, Meta, managers |
| `model_graph` | diagramme Mermaid des relations autour d'un modèle |
| `migrations_status` | migrations appliquées / en attente |
| `sqlmigrate` | SQL d'une migration |
| `sample_rows` | quelques lignes, champs sensibles masqués |
| `table_stats` | taille des tables et index, index inutilisés (`pg_stat_*` sur PostgreSQL) |

### Requêtes
| Outil | Rôle |
|---|---|
| `query` | QuerySet structuré (`model`, `filter`, `exclude`, `order_by`, `values`, `annotate`, `select_related`, `prefetch_related`, `limit`) : résultats + SQL + nombre de requêtes + durée |
| `run_queryset` | évalue une expression Python (namespace type `shell_plus`) — **exécution de code** |
| `explain_queryset` | `qs.explain(analyze=...)` adapté au moteur |
| `raw_sql` | SQL en lecture seule. **(contrat)** paramètre `sql` (ou `query`) |
| `aggregate` | agrégations simples |

### Écritures (dry-run par défaut)
`create_objects`, `update_objects`, `delete_objects` — **(contrat)** paramètre booléen
`dry_run` : si `true`, montrer le SQL et le nombre de lignes touchées puis annuler la transaction.

### Performance / N+1
| Outil | Rôle |
|---|---|
| `capture_queries` | exécute un snippet en capturant les requêtes (`connection.execute_wrapper`), regroupe par empreinte SQL normalisée, pile d'appels filtrée sur le code du projet — **exécution de code** |
| `profile_url` | appelle une URL avec `django.test.Client` (option `force_login`) et retourne le profil des requêtes |
| `profile_test` | lance un test (label) avec capture des requêtes |
| `suggest_optimizations` | suggestions select_related / prefetch_related / annotate / only / bulk_* à partir d'une capture |
| `index_advisor` | Seq Scan sur grosses tables, champs filtrés sans index → proposition de `Meta.indexes` |
| `compare_querysets` | avant/après : nombre de requêtes, temps, plan — **exécution de code** |

### Cycle de vie
`reload` : redémarre le worker Python pour prendre en compte les modifications de code.

## 4. Ce que le plugin fait côté client (hook `beforeTool`)

- outils d'écriture : `dry_run` forcé à `true` quand `safety.readOnly` est vrai ou `safety.allowWrites` faux ;
- `run_queryset`, `capture_queries`, `compare_querysets` : bloqués si `safety.allowCodeExecution` est faux ;
- `raw_sql` : refusé s'il contient plusieurs instructions ou une instruction autre que
  `SELECT` / `WITH` / `EXPLAIN` / `SHOW` / `VALUES` / `PRAGMA` en lecture, tant que les écritures sont désactivées.

## 5. Format de réponse recommandé

Texte compact (Markdown) pensé pour un LLM : tableaux courts, résultats tronqués avec
indication du total, SQL formaté, et pour les captures un résumé du type
`12 requêtes, 10 dupliquées (empreinte X, appelée depuis blog/views.py:14)`.
