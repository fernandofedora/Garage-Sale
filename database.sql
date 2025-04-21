CREATE DATABASE IF NOT EXISTS garage_sale;
USE garage_sale;

CREATE TABLE IF NOT EXISTS users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'super_admin') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS images (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  image_url VARCHAR(255) NOT NULL,
  is_blocked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add sold column to images table if it doesn't exist
ALTER TABLE images ADD COLUMN IF NOT EXISTS sold BOOLEAN DEFAULT FALSE;

-- If the above fails, try this alternative
-- ALTER TABLE images ADD COLUMN sold BOOLEAN DEFAULT FALSE;
