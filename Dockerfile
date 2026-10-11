FROM ubuntu:24.04

LABEL org.opencontainers.image.authors="Montala Ltd"

ENV DEBIAN_FRONTEND="noninteractive"

# Monthly patch refresh (see README, "Media tools: patching cadence"). The
# build cache would otherwise keep the first ImageMagick, ffmpeg, exiftool,
# ghostscript and libheif we ever installed; changing this value forces the
# apt layer below to re-run and pick up Ubuntu's security updates.
ARG PATCH_REFRESH=2026-10

# libheif-plugin-libde265: the HEVC decoder ImageMagick needs for iPhone HEIC.
RUN apt-get update && apt-get install -y \
    nano \
    imagemagick \
    libheif-plugin-libde265 \
    apache2 \
    subversion \
    ghostscript \
    antiword \
    poppler-utils \
    libimage-exiftool-perl \
    cron \
    postfix \
    wget \
    php \
    php-apcu \
    php-curl \
    php-dev \
    php-gd \
    php-intl \
    php-mysqlnd \
    php-mbstring \
    php-zip \
    libapache2-mod-php \
    ffmpeg \
    libopencv-dev \
    python3-opencv \
    python3 \
    python3-pip \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

RUN sed -i -e "s/max_execution_time\s*=\s*30/max_execution_time = 300/g" /etc/php/8.3/apache2/php.ini \
 && sed -i -e "s/memory_limit\s*=\s*128M/memory_limit = 1G/g" /etc/php/8.3/apache2/php.ini

# Upload size limits (1 GB videos, #18/#37). A conf.d drop-in overrides
# php.ini for both SAPIs, so `php -i` shows the same values Apache uses.
COPY php/uploads.ini /etc/php/8.3/apache2/conf.d/99-sdfwa-uploads.ini
COPY php/uploads.ini /etc/php/8.3/cli/conf.d/99-sdfwa-uploads.ini

# ImageMagick security policy: deny-list plus generous resource caps, not a
# format allowlist (ADR 0005). Replaces the Ubuntu default in the directory
# ImageMagick 6 reads; `identify -list policy` shows what is in force.
COPY imagemagick/policy.xml /etc/ImageMagick-6/policy.xml

RUN printf '<Directory /var/www/>\n\
\tOptions FollowSymLinks\n\
</Directory>\n'\
>> /etc/apache2/sites-enabled/000-default.conf

# Apache 2.4.54+ defaults LimitRequestBody to 1 GiB, which would reject a
# 1 GB upload plus multipart overhead before PHP sees it. Match post_max_size
# (1100M = 1153433600 bytes).
RUN echo 'LimitRequestBody 1153433600' > /etc/apache2/conf-available/sdfwa-uploads.conf \
 && a2enconf sdfwa-uploads

ADD cronjob /etc/cron.daily/resourcespace

WORKDIR /var/www/html

RUN rm -f index.html \
 && svn co -q -r 29660 https://svn.resourcespace.com/svn/rs/releases/11.0 . \
 && mkdir -p filestore \
 && chmod 777 filestore \
 && chmod -R 777 include/ \
 && chmod -R 777 plugins/
 

# Copy custom entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Copy the config from your repo into the image
COPY config.php /var/www/html/include/config.php
RUN chown www-data:www-data /var/www/html/include/config.php

# Start both cron and Apache
CMD ["/entrypoint.sh"]
