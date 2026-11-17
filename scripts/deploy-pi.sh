#!/usr/bin/env bash
# Builds the image on this Mac and runs the stack on the Raspberry Pi over SSH.
# The Pi needs only Docker: no compose plugin, no source checkout, no build there.
#
#   scripts/deploy-pi.sh            build, ship and restart
#   PI=user@host scripts/deploy-pi.sh
set -euo pipefail

PI=${PI:-pi@pi.local}
REMOTE_DIR=hroshi
# Voice notes: large-v3-turbo stays accurate in Ukrainian with the short audio window the bot uses.
WHISPER_MODEL=ggml-large-v3-turbo-q5_0.bin
WHISPER_SHA256=394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
cd "$(dirname "$0")/.."

remote_home=$(ssh "$PI" 'printf %s "$HOME"')
ssh "$PI" "mkdir -p $REMOTE_DIR/secrets $REMOTE_DIR/data/brokers && chmod 700 $REMOTE_DIR/secrets"
scp -q secrets/* "$PI:$REMOTE_DIR/secrets/"
ssh "$PI" "chmod 600 $REMOTE_DIR/secrets/*"
# The Pi owns the broker statements once it runs the syncs; only seed files it does not have.
tar -C data -cf - brokers | ssh "$PI" "tar -C $REMOTE_DIR/data -xf - --skip-old-files"
# The model is over half a gigabyte: fetched once by the Pi itself, not shipped with every image.
ssh "$PI" "mkdir -p $REMOTE_DIR/data/models && cd $REMOTE_DIR/data/models && { [ -f $WHISPER_MODEL ] ||
  { curl -fsSL --retry 3 -o $WHISPER_MODEL.part https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL &&
    echo '$WHISPER_SHA256  $WHISPER_MODEL.part' | sha256sum -c --quiet && mv $WHISPER_MODEL.part $WHISPER_MODEL; }; }"

docker build --platform linux/arm64 --target runtime -t hroshi .
docker build --platform linux/arm64 --target bot -t hroshi-bot .
# One archive: the bot image shares every layer but its last with the app image.
docker save hroshi:latest hroshi-bot:latest | gzip -1 | ssh "$PI" 'gunzip | docker load'

# Compose reads .env here and hands the values to the containers; bind mounts resolve on the Pi.
DOCKER_HOST="ssh://$PI" \
  SECRETS_DIR="$remote_home/$REMOTE_DIR/secrets" \
  BROKERS_DIR="$remote_home/$REMOTE_DIR/data/brokers" \
  MODELS_DIR="$remote_home/$REMOTE_DIR/data/models" \
  docker compose up -d --no-build "$@"
