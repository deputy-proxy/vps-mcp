# This profile currently targets the VPS host architecture (linux/amd64).
# Every upstream image is pinned to the amd64 manifest digest verified from
# Docker Hub; update pins only through a reviewed dependency refresh.
FROM docker.io/library/php:8.4.28-fpm-bookworm@sha256:1472c4a0440979669c27e93c6f60f80107cf49e285d326780f29bedd5393501b AS php-build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      $PHPIZE_DEPS \
      libfreetype6-dev \
      libicu-dev \
      libjpeg62-turbo-dev \
      libonig-dev \
      libpng-dev \
      libzip-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j2 \
      bcmath \
      exif \
      gd \
      intl \
      mbstring \
      opcache \
      pcntl \
      pdo_mysql \
      sockets \
      zip \
    && rm -rf /var/lib/apt/lists/*

FROM docker.io/library/composer:2.9.2@sha256:ebf71d99335126039325670627d3168fba3a1678e97740e9fbda69525f2831bf AS composer
FROM docker.io/library/node:22.23.0-bookworm-slim@sha256:dc73bdac873c82e6cbfa496e35dd6e27a20302ebba043d0d9646708df19a9996 AS node
RUN npm install --global npm@12.2.3 && npm cache clean --force

FROM docker.io/library/php:8.4.28-fpm-bookworm@sha256:1472c4a0440979669c27e93c6f60f80107cf49e285d326780f29bedd5393501b AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libfreetype6 \
      libicu72 \
      libjpeg62-turbo \
      libonig5 \
      libpng16-16 \
      libzip4 \
      git \
      unzip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --home-dir /app --create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app /app

COPY --from=php-build /usr/local/lib/php/extensions/ /usr/local/lib/php/extensions/
COPY --from=php-build /usr/local/etc/php/conf.d/ /usr/local/etc/php/conf.d/
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY runtime/laravel-php/php-fpm.conf /usr/local/etc/php-fpm.conf
COPY runtime/laravel-php/www.conf /usr/local/etc/php-fpm.d/www.conf

RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && chown -R root:root /usr/local/bin/node /usr/local/bin/composer /usr/local/lib/node_modules/npm \
    && chmod -R a+rX /usr/local/lib/node_modules/npm

ENV HOME=/app \
    COMPOSER_HOME=/tmp/composer \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    PHP_FPM_PM_MAX_CHILDREN=4

WORKDIR /app
USER 10001:10001
EXPOSE 9000

ENTRYPOINT ["php-fpm"]
CMD ["--nodaemonize"]