
FROM php:8.1-apache
RUN docker-php-ext-install mysqli

RUN apt-get update && \
    apt-get install -y libfreetype6-dev libjpeg62-turbo-dev libpng-dev && \
    docker-php-ext-configure gd --with-freetype=/usr/include/ --with-jpeg=/usr/include/ && \
    docker-php-ext-install gd

RUN docker-php-ext-install mysqli pdo pdo_mysql

#COPY www/configuration.php www/joomla/configuration.php
