require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs').promises;

const app = express();

// Configuración de CORS
const corsOptions = {
  origin: 'https://garage-sale-production-adbe.up.railway.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());



// Servir archivos estáticos desde el directorio public
//app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '.')))
// Servir archivos estáticos con CORS
app.use('/uploads', cors(corsOptions), express.static(path.join(__dirname, 'public', 'uploads')));

// Create connection pool for database
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'garage_sale',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Database setup
async function setupDatabase() {
  let setupConnection;
  try {
    // Create database if it doesn't exist
    setupConnection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || ''
    });

    await setupConnection.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME || 'garage_sale'}`);
    await setupConnection.query(`USE ${process.env.DB_NAME || 'garage_sale'}`);
    
    // Create users table
    await setupConnection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin', 'super_admin') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create images table if not exists
    await setupConnection.query(`
      CREATE TABLE IF NOT EXISTS images (
        id INT PRIMARY KEY AUTO_INCREMENT,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        image_url VARCHAR(255) NOT NULL,
        is_blocked BOOLEAN DEFAULT FALSE,
        sold BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Asegurarse de que la columna sold existe
    try {
      await setupConnection.query(`
        SELECT sold FROM images LIMIT 1
      `);
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        await setupConnection.query(`
          ALTER TABLE images ADD COLUMN sold BOOLEAN DEFAULT FALSE
        `);
        console.log('Columna sold agregada a la tabla images');
      }
    }

    console.log('Database setup completed successfully');
  } catch (err) {
    console.error('Error setting up database:', err);
    process.exit(1);
  } finally {
    if (setupConnection) {
      await setupConnection.end();
    }
  }
}

// Configuración de multer para subir imágenes
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB límite
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif, webp)'));
    }
  }
});

// Función para optimizar imagen
async function optimizeImage(inputPath, outputPath) {
  try {
    await sharp(inputPath)
      .resize(800, 600, { // tamaño máximo
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 80 }) // convertir a webp para mejor compresión
      .toFile(outputPath);

    // Eliminar archivo original
    await fs.unlink(inputPath);
    return outputPath;
  } catch (error) {
    console.error('Error optimizing image:', error);
    throw error;
  }
}

// Middleware to verify JWT token and role
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = decoded;
    next();
  });
};

// Middleware to verify admin role
const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Requires admin privileges' });
  }
  next();
};

// Routes
// Login route
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create super admin (only available during initial setup)
app.post('/api/create-super-admin', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE role = "super_admin"');
    if (users.length > 0) {
      return res.status(403).json({ error: 'Super admin already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password, role) VALUES (?, ?, "super_admin")',
      [username, hashedPassword]
    );
    res.json({ message: 'Super admin created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create admin (only available to super admin)
app.post('/api/create-admin', verifyToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only super admin can create admins' });
  }

  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password, role) VALUES (?, ?, "admin")',
      [username, hashedPassword]
    );
    res.json({ message: 'Admin created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload image
app.post('/api/images', verifyToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ninguna imagen' });
    }

    // Optimizar imagen
    const originalPath = req.file.path;
    const optimizedPath = originalPath.replace(/\.[^.]+$/, '.webp');
    await optimizeImage(originalPath, optimizedPath);

    // Crear URL relativa para la base de datos
    const imageUrl = '/uploads/' + path.basename(optimizedPath);

    const [result] = await pool.query(
      'INSERT INTO images (title, description, price, image_url) VALUES (?, ?, ?, ?)',
      [req.body.title, req.body.description, req.body.price, imageUrl]
    );

    res.json({ 
      id: result.insertId,
      title: req.body.title,
      description: req.body.description,
      price: req.body.price,
      image_url: imageUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir la imagen' });
  }
});

// Get all images
app.get('/api/images', async (req, res) => {
  try {
    const [images] = await pool.query('SELECT * FROM images ORDER BY created_at DESC');
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Buy image (public access)
app.post('/api/images/:id/buy', async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE images SET sold = TRUE WHERE id = ? AND sold = FALSE',
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'Image not available for purchase' });
    }

    res.json({ message: 'Purchase successful' });
  } catch (err) {
    console.error('Error processing purchase:', err);
    res.status(500).json({ error: 'Error processing purchase' });
  }
});

// Toggle block status (admin only)
app.put('/api/images/:id/toggle-block', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE images SET is_blocked = NOT is_blocked WHERE id = ?',
      [req.params.id]
    );
    res.json({ message: 'Image status updated successfully' });
  } catch (err) {
    console.error('Error updating image status:', err);
    res.status(500).json({ error: 'Error updating image status' });
  }
});

// Toggle sold status (admin only)
app.put('/api/images/:id/toggle-sold', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE images SET sold = NOT sold WHERE id = ?',
      [req.params.id]
    );
    res.json({ message: 'Image sold status updated successfully' });
  } catch (err) {
    console.error('Error updating image sold status:', err);
    res.status(500).json({ error: 'Error updating image sold status' });
  }
});

// Update image (admin only)
app.put('/api/images/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { title, description, price } = req.body;
    const [result] = await pool.query(
      'UPDATE images SET title = ?, description = ?, price = ? WHERE id = ?',
      [title, description, price, req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.json({ message: 'Image updated successfully' });
  } catch (err) {
    console.error('Error updating image:', err);
    res.status(500).json({ error: 'Error updating image' });
  }
});

// Delete image (admin only)
app.delete('/api/images/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    // Primero obtener la URL de la imagen
    const [rows] = await pool.query('SELECT image_url FROM images WHERE id = ?', [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Eliminar el archivo físico
    const imagePath = path.join(__dirname, 'public', rows[0].image_url);
    try {
      await fs.unlink(imagePath);
    } catch (err) {
      console.error('Error deleting image file:', err);
      // Continuar incluso si el archivo no se puede eliminar
    }

    // Eliminar el registro de la base de datos
    const [result] = await pool.query('DELETE FROM images WHERE id = ?', [req.params.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.json({ message: 'Image deleted successfully' });
  } catch (err) {
    console.error('Error deleting image:', err);
    res.status(500).json({ error: 'Error deleting image' });
  }
});

// Initialize database and start server
async function startServer() {
  await setupDatabase();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
