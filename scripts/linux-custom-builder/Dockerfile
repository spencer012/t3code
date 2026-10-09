FROM ghcr.io/voidzero-dev/vite-plus:1.0.0

RUN sudo apt-get update \
    && sudo apt-get install -y --no-install-recommends \
        ca-certificates curl git rsync build-essential python3 \
        libsecret-1-dev pkg-config imagemagick \
    && sudo rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --profile minimal

ENV PATH="/home/vp/.cargo/bin:${PATH}" \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    T3CODE_DESKTOP_SKIP_BUILD=false \
    pnpm_config_store_dir=/home/vp/.cache/pnpm/store

RUN mkdir -p /home/vp/workspace /home/vp/.cache
WORKDIR /home/vp/workspace
ENTRYPOINT ["bash"]
