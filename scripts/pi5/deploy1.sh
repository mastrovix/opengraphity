#!/usr/bin/env bash
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

echo ""
echo "Blocco 1 completato. Ora lancia deploy2.sh"
