# Lokale TLS-Zertifikate

```bash
sudo apt install libnss3-tools mkcert -y
mkcert -install
cd traefik && mkdir -p certs
mkcert -cert-file certs/local-cert.pem -key-file certs/local-key.pem \
  "mynotes.localhost" "*.mynotes.localhost"
```

`/etc/hosts`:
```
127.0.0.1 mynotes.localhost api.mynotes.localhost phpmyadmin.mynotes.localhost traefik.localhost
```
