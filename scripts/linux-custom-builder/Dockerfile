FROM ghcr.io/voidzero-dev/vite-plus:1.0.0

RUN sudo apt-get update \
    && sudo apt-get install -y --no-install-recommends \
        ca-certificates curl git rsync build-essential python3 \
        libsecret-1-dev pkg-config imagemagick \
    && sudo rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --profile minimal

# Socket Firewall: every package-manager download in the build goes through it.
ARG SFW_VERSION=1.15.4
ARG SFW_SHA256=cf9f55b8343e1ef6e6dcccdb09b99c70c0430a22ed7d0079286eccddeaf72670
RUN curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/sfw \
        "https://github.com/SocketDev/sfw-free/releases/download/v${SFW_VERSION}/sfw-free-linux-x86_64" \
    && echo "${SFW_SHA256}  /tmp/sfw" | sha256sum -c - \
    && sudo install -m 755 /tmp/sfw /usr/local/bin/sfw \
    && rm -f /tmp/sfw

ENV PATH="/home/vp/.cargo/bin:${PATH}" \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    T3CODE_DESKTOP_SKIP_BUILD=false \
    pnpm_config_store_dir=/home/vp/.cache/pnpm/store

RUN mkdir -p /home/vp/workspace /home/vp/.cache
WORKDIR /home/vp/workspace
ENTRYPOINT ["bash"]
