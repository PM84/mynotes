
FROM php:7.3-apache 
RUN docker-php-ext-install mysqli
#COPY www/configuration.php www/joomla/configuration.php