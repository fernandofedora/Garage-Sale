@echo off
mysql -u root -pfnoel1995 -e "CREATE DATABASE IF NOT EXISTS garage_sale;"
mysql -u root -pfnoel1995 garage_sale < database.sql
