# resourcespace/docker
The official Docker image for ResourceSpace. Full build instructions can be found on our [Knowledge Base](https://www.resourcespace.com/knowledge-base/systemadmin/install_docker).

# Installation notes
* Before building the Docker image, change the db.env file replacing the default "change-me" passwords to secure values.
* When setting up ResourceSpace ensure you enter "mariadb" as the MySQL server instead of "localhost" and leave the "MySQL binary path" empty.

# ResourceSpace version
This deployment runs ResourceSpace **11.0** (pinned via SVN `releases/11.0` in the `Dockerfile`). After upgrading from a previous version, **back up the MariaDB database first**, then log in as admin — ResourceSpace will prompt to run the 11.0 schema upgrade.

# CLIP AI Smart Search
The [CLIP AI Smart Search](https://www.resourcespace.com/knowledge-base/plugins/clip-ai-smart-search) plugin is enabled in `config.php`. Its CPU-only inference service runs as a separate `clip` container (see `clip/Dockerfile` and the `clip` service in `docker-compose.yaml`), reachable from ResourceSpace at `http://clip:8000` via `CLIP_SERVICE_URL`. The service connects to the `mariadb` database using the root credentials to read/write the `resource_clip_vector` table.

After deploying, generate vectors for existing resources once, then restart the clip service so it reloads the FAISS index:
```
docker compose exec resourcespace php /var/www/html/plugins/clip/scripts/generate_vectors.php
docker compose restart clip
```
New uploads are vectorised automatically.

# AI Faces (InsightFace)
Intentionally **not installed** for now. The default `buffalo_l` model requires a commercial license for non-research use unless covered by a Montala support/hosting contract. Resolve licensing before adding the `faces` plugin and its service.
