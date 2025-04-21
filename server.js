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

// Crear el directorio public/uploads si no existe
async function ensureUploadsDir() {
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
    console.log('Directorio public/uploads creado o ya existe');
  } catch (err) {
    console.error('Error al crear el directorio public/uploads:', err);
  }
}
// Llamar a la función al iniciar el servidor
ensureUploadsDir();

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
app.use(express.static(path.join(__dirname, '.')));
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
        coming_soon BOOLEAN DEFAULT FALSE,
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

    // Asegurarse de que la columna coming_soon existe
    try {
      await setupConnection.query(`
        SELECT coming_soon FROM images LIMIT 1
      `);
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        await setupConnection.query(`
          ALTER TABLE images ADD COLUMN coming_soon BOOLEAN DEFAULT FALSE
        `);
        console.log('Columna coming_soon agregada a la tabla images');
      }
    }

    // Crear tabla de ventas
    await setupConnection.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id INT PRIMARY KEY AUTO_INCREMENT,
        image_id INT NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Verificar si la clave foránea existe y tiene ON DELETE CASCADE
    const [constraints] = await setupConnection.query(`
      SELECT CONSTRAINT_NAME, DELETE_RULE
      FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE TABLE_NAME = 'sales' AND CONSTRAINT_SCHEMA = ?
    `, [process.env.DB_NAME || 'garage_sale']);

    const fkExists = constraints.find(c => c.CONSTRAINT_NAME === 'sales_ibfk_1');
    if (fkExists && fkExists.DELETE_RULE !== 'CASCADE') {
      // Eliminar y recrear la clave foránea si no tiene ON DELETE CASCADE
      await setupConnection.query(`ALTER TABLE sales DROP FOREIGN KEY sales_ibfk_1`);
      await setupConnection.query(`
        ALTER TABLE sales 
        ADD CONSTRAINT sales_ibfk_1 
        FOREIGN KEY (image_id) REFERENCES images(id) 
        ON DELETE CASCADE
      `);
    } else if (!fkExists) {
      // Crear la clave foránea si no existe
      await setupConnection.query(`
        ALTER TABLE sales 
        ADD CONSTRAINT sales_ibfk_1 
        FOREIGN KEY (image_id) REFERENCES images(id) 
        ON DELETE CASCADE
      `);
    }

    console.log('Configuración de la base de datos completada exitosamente');
  } catch (err) {
    console.error('Error al configurar la base de datos:', err);
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
    cb(null, `${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`); // Usar extensión original
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB límite
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
    // Verificar si el archivo de entrada existe
    await fs.access(inputPath);

    // Convertir y optimizar la imagen
    await sharp(inputPath)
      .resize(800, 600, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 80 })
      .toFile(outputPath);

    // Verificar si el archivo optimizado se creó correctamente
    await fs.access(outputPath);

    console.log(`Imagen optimizada: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error('Error al optimizar la imagen:', error.message);
    // Si la optimización falla, eliminar el archivo optimizado (si existe)
    try {
      await fs.unlink(outputPath);
    } catch (err) {
      console.warn('No se pudo eliminar el archivo optimizado fallido:', err.message);
    }
    throw new Error('Fallo al optimizar la imagen: ' + error.message);
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

// Middleware to verify super admin role
const verifySuperAdmin = (req, res, next) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Requires super admin privileges' });
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
app.post('/api/images', verifyToken, upload.single('image'), async (req, res, next) => {
  try {
    // Verificar que se haya subido una imagen
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ninguna imagen' });
    }

    // Validar los campos title, description y price
    const { title, description, price } = req.body;
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'El título es obligatorio y debe ser una cadena no vacía' });
    }
    if (description && typeof description !== 'string') {
      return res.status(400).json({ error: 'La descripción debe ser una cadena de texto' });
    }
    const priceNumber = parseFloat(price);
    if (isNaN(priceNumber) || priceNumber <= 0) {
      return res.status(400).json({ error: 'El precio debe ser un número mayor que 0' });
    }

    // Optimizar imagen
    const originalPath = req.file.path; // Ejemplo: public/uploads/1745194426166-844855877.jpg
    const optimizedFileName = `${path.basename(originalPath, path.extname(originalPath))}.webp`; // Ejemplo: 1745194426166-844855877.webp
    const optimizedPath = path.join(path.dirname(originalPath), optimizedFileName); // Ruta completa para el archivo optimizado

    console.log(`Optimizando imagen: de ${originalPath} a ${optimizedPath}`);
    await optimizeImage(originalPath, optimizedPath);

    // Eliminar el archivo original después de la optimización exitosa
    try {
      await fs.unlink(originalPath);
      console.log(`Archivo original eliminado: ${originalPath}`);
    } catch (err) {
      console.warn(`No se pudo eliminar el archivo original: ${err.message}`);
    }

    // Crear URL relativa para la base de datos
    const imageUrl = '/uploads/' + optimizedFileName;

    // Insertar en la base de datos
    const [result] = await pool.query(
      'INSERT INTO images (title, description, price, image_url) VALUES (?, ?, ?, ?)',
      [title.trim(), description ? description.trim() : null, priceNumber, imageUrl]
    );

    res.json({ 
      id: result.insertId,
      title: title.trim(),
      description: description ? description.trim() : null,
      price: priceNumber,
      image_url: imageUrl
    });
  } catch (err) {
    console.error('Error al subir la imagen:', err.message);
    // Si hay un error, eliminar el archivo original si aún existe
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkErr) {
        console.warn('No se pudo eliminar el archivo original después del error:', unlinkErr.message);
      }
    }
    next(err); // Pasar el error al middleware de manejo de errores
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

// Buy image with customer name
app.post('/api/images/:id/buy', async (req, res) => {
  try {
    const { customerName } = req.body;
    
    // Primero verificar si la imagen está disponible
    const [image] = await pool.query('SELECT * FROM images WHERE id = ? AND sold = FALSE', [req.params.id]);
    if (image.length === 0) {
      return res.status(400).json({ error: 'Image not available for purchase' });
    }

    // Iniciar transacción
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Actualizar estado de la imagen
      await connection.query('UPDATE images SET sold = TRUE WHERE id = ?', [req.params.id]);

      // Registrar la venta
      await connection.query('INSERT INTO sales (image_id, customer_name) VALUES (?, ?)', 
        [req.params.id, customerName]);

      await connection.commit();
      res.json({ message: 'Purchase successful' });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('Error processing purchase:', err);
    res.status(500).json({ error: 'Error processing purchase' });
  }
});

// Get sales history (super admin only)
app.get('/api/sales', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const [sales] = await pool.query(
      'SELECT s.*, i.title as product_name FROM sales s JOIN images i ON s.image_id = i.id ORDER BY s.purchase_date DESC'
    );
    res.json(sales);
  } catch (err) {
    console.error('Error fetching sales:', err);
    res.status(500).json({ error: 'Error fetching sales' });
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

// Toggle coming soon status (super admin only)
app.put('/api/images/:id/toggle-coming-soon', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE images SET coming_soon = NOT coming_soon WHERE id = ?',
      [req.params.id]
    );
    res.json({ message: 'Image coming soon status updated successfully' });
  } catch (err) {
    console.error('Error updating image coming soon status:', err);
    res.status(500).json({ error: 'Error updating image coming soon status' });
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
    // Obtener la URL de la imagen
    const [rows] = await pool.query('SELECT image_url FROM images WHERE id = ?', [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Imagen no encontrada' });
    }

    // Eliminar el registro de la base de datos primero
    const [result] = await pool.query('DELETE FROM images WHERE id = ?', [req.params.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Imagen no encontrada' });
    }

    // Intentar eliminar el archivo físico
    const imageUrl = rows[0].image_url; // Por ejemplo, "/uploads/1743968545572-123456789.webp"
    const imagePath = path.join(__dirname, 'public', imageUrl); // Ruta completa

    // Intentar eliminar el archivo con la extensión almacenada (.webp)
    try {
      await fs.access(imagePath);
      await fs.unlink(imagePath);
      console.log(`Archivo eliminado exitosamente: ${imagePath}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn(`Archivo no encontrado, omitiendo eliminación: ${imagePath}`);
      } else {
        console.error('Error al eliminar el archivo de imagen:', err);
      }
    }

    // Intentar eliminar posibles archivos originales con otras extensiones (como .jpg, .png, etc.)
    const baseFileName = path.basename(imageUrl, '.webp'); // Obtener el nombre sin extensión
    const possibleExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
    for (const ext of possibleExtensions) {
      const possibleFilePath = path.join(__dirname, 'public', 'uploads', `${baseFileName}${ext}`);
      try {
        await fs.access(possibleFilePath);
        await fs.unlink(possibleFilePath);
        console.log(`Archivo original eliminado: ${possibleFilePath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Error al eliminar posible archivo original ${possibleFilePath}:`, err);
        }
      }
    }

    res.json({ message: 'Imagen eliminada exitosamente' });
  } catch (err) {
    console.error('Error al eliminar la imagen:', err);
    res.status(500).json({ error: 'Error al eliminar la imagen' });
  }
});

// Script para limpiar la carpeta public/uploads (ejecutar una vez y luego eliminar)
async function cleanUploadsFolder() {
  try {
    // Obtener todas las URLs de imágenes desde la base de datos
    const [images] = await pool.query('SELECT image_url FROM images');
    const validFiles = images.map(img => path.basename(img.image_url)); // Ejemplo: ["1743962988919-180291048.webp", ...]

    // Obtener todos los archivos en la carpeta public/uploads
    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    const files = await fs.readdir(uploadsDir);

    // Eliminar archivos que no estén en la base de datos
    for (const file of files) {
      if (!validFiles.includes(file)) {
        const filePath = path.join(uploadsDir, file);
        await fs.unlink(filePath);
        console.log(`Archivo eliminado (no registrado en la base de datos): ${filePath}`);
      }
    }

    console.log('Limpieza de la carpeta uploads completada');
  } catch (err) {
    console.error('Error al limpiar la carpeta uploads:', err);
  }
}

// Middleware para manejar errores de multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'El archivo es demasiado grande. El límite es de 10 MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Middleware general para manejar errores no capturados
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err.message);
  res.status(500).json({ error: 'Error interno del servidor: ' + err.message });
});

// Initialize database and start server
async function startServer() {
  await setupDatabase();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

// Iniciar el servidor y ejecutar la limpieza (descomentar la línea de cleanUploadsFolder solo para ejecutarla una vez)
startServer().then(() => {
  // cleanUploadsFolder(); // Descomentar esta línea para ejecutar la limpieza una vez, luego volver a comentarla
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});