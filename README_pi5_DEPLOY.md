# Deploy OpenGrafo su Raspberry Pi 5

## Prerequisiti
- Raspberry Pi 5 con 8-16GB RAM
- Raspberry Pi OS (64-bit) o Ubuntu Server 24.04 ARM64
- Connessione internet
- SSH abilitato

## Installazione automatica

Dal Mac, copia e incolla nel terminale (sostituisci UTENTE e IP):

### Blocco 1 — Setup, build e avvio infrastruttura
```bash
ssh mastrovix@192.168.1.119 'bash -s' << 'DEPLOY_EOF'
set -e

echo "=== 1. Installazione Docker ==="
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  echo "Docker installato. Fai logout/login e rilancia lo script."
  exit 1
fi

echo "=== 2. Fix IPv6 Docker ==="
if [ ! -f /etc/docker/daemon.json ] || ! grep -q "ip6tables" /etc/docker/daemon.json 2>/dev/null; then
  sudo mkdir -p /etc/docker
  echo '{"ip6tables": false, "fixed-cidr-v6": ""}' | sudo tee /etc/docker/daemon.json
  sudo systemctl restart docker
  sleep 5
fi

echo "=== 3. Clone repository ==="
cd ~
if [ ! -d "opengraphity" ]; then
  git clone https://github.com/mastrovix/opengraphity.git
fi
cd opengraphity
git pull

echo "=== 4. Rileva IP e configurazione ==="
PI_IP=$(hostname -I | awk '{print $1}')
echo "IP rilevato: $PI_IP"

cat > .env << ENVEOF
NEO4J_PASSWORD=opengraphity_local
KEYCLOAK_ADMIN_PASSWORD=opengrafo_local
PI_IP=$PI_IP
ENVEOF

echo "=== 5. Configurazione Keycloak realm ==="
cp keycloak-realm_pi5.json keycloak-realm_pi5_local.json
sed -i "s/REPLACE_PI_IP/$PI_IP/g" keycloak-realm_pi5_local.json

echo "=== 6. Certificato HTTPS self-signed ==="
if [ ! -f certs_pi5/selfsigned.crt ]; then
  sudo mkdir -p certs_pi5
  sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout certs_pi5/selfsigned.key \
    -out certs_pi5/selfsigned.crt \
    -subj "/CN=opengrafo.local"
  sudo chmod 644 certs_pi5/selfsigned.crt
  sudo chmod 600 certs_pi5/selfsigned.key
fi

echo "=== 7. Build immagini (10-15 min la prima volta) ==="
docker compose -f docker-compose_pi5.yml build

echo "=== 8. Avvio infrastruttura (senza API) ==="
docker compose -f docker-compose_pi5.yml up -d neo4j redis keycloak web

echo "=== 9. Attesa servizi ==="
echo "Attendo Neo4j..."
until docker compose -f docker-compose_pi5.yml exec -T neo4j bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/7474' 2>/dev/null; do
  sleep 10
  echo "  Neo4j non pronto..."
done
echo "Neo4j pronto!"

echo "Attendo Keycloak..."
until docker compose -f docker-compose_pi5.yml exec -T keycloak bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/8080' 2>/dev/null; do
  sleep 10
  echo "  Keycloak non pronto..."
done
echo "Keycloak pronto!"

DEPLOY_EOF
```

### Blocco 2 — Avvio API e verifica finale
```bash
ssh mastrovix@192.168.1.119 'bash -s' << 'DEPLOY_EOF2'
cd ~/opengraphity

echo "=== 10. Avvio API ==="
docker compose -f docker-compose_pi5.yml up -d api
sleep 20

echo "=== 11. Verifica ==="
docker compose -f docker-compose_pi5.yml ps

PI_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "============================================"
echo "  OpenGrafo installato con successo!"
echo "============================================"
echo "  App:          https://$PI_IP"
echo "  Neo4j:        http://$PI_IP:7474"
echo "  Keycloak:     http://$PI_IP:8080/admin"
echo ""
echo "  Login App:    admin@demo.opengrafo.io / Demo1234"
echo "  Neo4j:        neo4j / opengraphity_local"
echo "  Keycloak:     admin / opengrafo_local"
echo "============================================"
echo ""
echo "  NOTA: Accetta il certificato self-signed"
echo "        nel browser (Avanzate > Procedi)"
echo "============================================"
DEPLOY_EOF2
```

## Backup e restore Neo4j (opzionale)

### Export dal Mac:
```bash
cd ~/Developer/opengraphity
mkdir -p ~/neo4j-backup
docker compose -f infra/docker-compose.yml stop neo4j
docker compose -f infra/docker-compose.yml run --rm -v $HOME/neo4j-backup:/backup neo4j neo4j-admin database dump neo4j --to-path=/backup
docker compose -f infra/docker-compose.yml start neo4j
```

### Copia sul Pi:
```bash
scp ~/neo4j-backup/neo4j.dump mastrovix@192.168.1.119:~/neo4j-backup.dump
```

### Restore sul Pi:
```bash
ssh mastrovix@192.168.1.119 'bash -s' << 'EOF'
cd ~/opengraphity
docker compose -f docker-compose_pi5.yml stop api
docker compose -f docker-compose_pi5.yml stop neo4j
docker compose -f docker-compose_pi5.yml run --rm -v ~/neo4j-backup.dump:/backup/neo4j.dump neo4j neo4j-admin database load neo4j --from-path=/backup --overwrite-destination=true
docker compose -f docker-compose_pi5.yml up -d neo4j
sleep 30

# Aggiorna user_id dashboard
NEW_ID=$(docker compose -f docker-compose_pi5.yml exec -T keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password opengrafo_local 2>/dev/null && docker compose -f docker-compose_pi5.yml exec -T keycloak /opt/keycloak/bin/kcadm.sh get users -r opengrafo --fields id --format csv --noquotes 2>/dev/null | tail -1 | tr -d '\r')
echo "Nuovo user_id: $NEW_ID"
docker compose -f docker-compose_pi5.yml exec -T neo4j cypher-shell -u neo4j -p opengraphity_local "MATCH (d:DashboardConfig) WHERE d.user_id IS NOT NULL SET d.user_id = '$NEW_ID' RETURN d.name, d.user_id"

docker compose -f docker-compose_pi5.yml restart api
sleep 15
echo "Restore completato!"
EOF
```

## Comandi utili
```bash
# Stato
ssh mastrovix@192.168.1.119 'cd ~/opengraphity && docker compose -f docker-compose_pi5.yml ps'

# Log API
ssh mastrovix@192.168.1.119 'cd ~/opengraphity && docker compose -f docker-compose_pi5.yml logs -f api'

# Riavvio completo
ssh mastrovix@192.168.1.119 'cd ~/opengraphity && docker compose -f docker-compose_pi5.yml restart'

# Stop
ssh mastrovix@192.168.1.119 'cd ~/opengraphity && docker compose -f docker-compose_pi5.yml down'

# Rebuild dopo aggiornamento codice
ssh mastrovix@192.168.1.119 'cd ~/opengraphity && git pull && docker compose -f docker-compose_pi5.yml up -d --build'
```

## Risorse stimate
| Servizio | RAM |
|----------|-----|
| Neo4j | ~4GB |
| API Node.js | ~512MB |
| Keycloak | ~512MB |
| Redis | ~256MB |
| Nginx | ~64MB |
| OS | ~1GB |
| **Totale** | **~6.5GB su 16GB** |
