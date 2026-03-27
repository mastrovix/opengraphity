# Deploy OpenGrafo su Raspberry Pi 5

## Prerequisiti
- Raspberry Pi 5 con 8GB+ RAM (16GB consigliati per Neo4j)
- Raspberry Pi OS (64-bit) o Ubuntu Server 24.04 ARM64
- Docker e Docker Compose installati
- Git installato

---

## 1. Installazione Docker (se non presente)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Esci e rientra nella sessione
newgrp docker
```

Verifica:
```bash
docker --version
docker compose version
```

---

## 2. Clona il repo

```bash
git clone https://github.com/mastrovix/opengraphity.git
cd opengraphity
```

---

## 3. Configura le variabili d'ambiente

```bash
cp .env_pi5.example .env
nano .env   # cambia le password
```

---

## 4. Build e avvio

```bash
docker compose -f docker-compose_pi5.yml --env-file .env up -d --build
```

Il primo avvio richiede ~10-20 minuti per la build (compilazione TypeScript + download immagini).

---

## 5. Verifica stato servizi

```bash
docker compose -f docker-compose_pi5.yml ps
docker compose -f docker-compose_pi5.yml logs -f api
```

---

## 6. Accesso

| Servizio     | URL                        |
|--------------|----------------------------|
| App web      | http://<ip-pi>             |
| Neo4j Browser| http://<ip-pi>:7474        |
| RabbitMQ UI  | http://<ip-pi>:15672       |

---

## 7. Seed del database (primo avvio)

Una volta che i container sono up:

```bash
docker compose -f docker-compose_pi5.yml exec api node apps/api/dist/scripts/seed-metamodel.js
docker compose -f docker-compose_pi5.yml exec api node apps/api/dist/scripts/seed-cmdb.js
```

---

## 8. Aggiornamento

```bash
git pull
docker compose -f docker-compose_pi5.yml up -d --build
```

---

## Note TNAS

Se usi un TNAS (TerraMaster) invece di un Pi 5:
- Verifica che il NAS supporti Docker (TOS 5.x con Docker Manager)
- L'architettura è x86_64 (Intel/AMD), quindi rimuovi `platform: linux/arm64` dal docker-compose
- Accedi al Docker Manager dal pannello TOS e usa `docker-compose_pi5.yml` come stack
- Porta 80 potrebbe essere occupata dal pannello TOS → cambia in `8080:80`

---

## Troubleshooting

**Neo4j non parte**: aumenta la memoria heap se il Pi ha meno di 8GB:
```yaml
NEO4J_server_memory_heap_max__size: 2g
NEO4J_server_memory_pagecache_size: 512m
```

**Build fallisce (ENOMEM)**: aggiungi swap:
```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=4096/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

**Porta 80 occupata**: modifica `ports` in docker-compose:
```yaml
ports:
  - "8080:80"
```
