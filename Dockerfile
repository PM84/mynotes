
FROM php:7.4-apache
RUN docker-php-ext-install mysqli
#COPY www/configuration.php www/joomla/configuration.php