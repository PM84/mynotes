# Shutdown the docker
```
bin/moodle-docker-compose stop
```

# Install mkcert in home directory
```
sudo apt install libnss3-tools -y
wget https://github.com/FiloSottile/mkcert/releases/download/v1.4.3/mkcert-v1.4.3-linux-amd64
sudo cp mkcert-v1.4.3-linux-amd64 /usr/local/bin/mkcert
sudo chmod +x /usr/local/bin/mkcert
```
# If it's the firt install of mkcert, run
```
mkcert -install
```

# Execute in ./traefik directory:
```
mkcert -cert-file certs/local-cert.pem -key-file certs/local-key.pem "website.localhost" "phpmyadmin.localhost"
```

# Optionally run one more time:
```
mkcert -install
```
# Remove the the eventually existing network:
```
docker network rm mynet
```
# Create a new network:
```
docker network create mynet
```

# Restart the docker

# Some times the browser has to be restarted.

As a reference see: https://github.com/Heziode/traefik-v2-https-ssl-localhost