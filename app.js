// Determina las URLs del backend según el entorno
const API_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:3000/api' 
  : 'https://garage-sale-production-adbe.up.railway.app/api';

const BASE_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:3000' 
  : 'https://garage-sale-production-adbe.up.railway.app';

let token = localStorage.getItem('token');
let userRole = null;

// Decodificar el token para obtener el rol del usuario
function updateUserRole() {
  userRole = null;
  token = localStorage.getItem('token');
  
  if (token) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));

      const decoded = JSON.parse(jsonPayload);
      userRole = decoded.role;
    } catch (e) {
      console.error('Error decoding token:', e);
    }
  }
}

// Llamar a updateUserRole al inicio
updateUserRole();

// Elementos del DOM
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const adminControls = document.getElementById('adminControls');
const imageContainer = document.getElementById('imageContainer');
const loginModalElement = document.getElementById('loginModal');
const loginModal = new bootstrap.Modal(loginModalElement);
const addImageModal = new bootstrap.Modal(document.getElementById('addImageModal'));
const viewImageModal = new bootstrap.Modal(document.getElementById('viewImageModal'));
const editModal = new bootstrap.Modal(document.getElementById('editModal'));
const editForm = document.getElementById('editForm');
let currentEditId = null;

// Elementos para agregar imagen
const addImageForm = document.getElementById('addImageForm');
const addImageTitle = document.getElementById('addImageTitle');
const addImageDescription = document.getElementById('addImageDescription');
const addImagePrice = document.getElementById('addImagePrice');
const addImageFile = document.getElementById('addImageFile');

// Limpiar backdrop al cerrar el modal
loginModalElement.addEventListener('hidden.bs.modal', function () {
  const backdrop = document.querySelector('.modal-backdrop');
  if (backdrop) {
    backdrop.remove();
  }
  document.body.classList.remove('modal-open');
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
});

// Configuración del botón mostrar/ocultar contraseña
const togglePassword = document.getElementById('togglePassword');
const passwordInput = document.getElementById('password');

togglePassword.addEventListener('click', function () {
  const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
  passwordInput.setAttribute('type', type);
  
  // Cambiar el ícono
  const icon = this.querySelector('i');
  icon.className = type === 'password' ? 'bi bi-eye-slash' : 'bi bi-eye';
});

// Event Listeners
document.getElementById('loginForm').addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', logout);
loginBtn.addEventListener('click', () => {
  // Limpiar cualquier backdrop existente antes de mostrar el modal
  const backdrop = document.querySelector('.modal-backdrop');
  if (backdrop) backdrop.remove();
  document.body.classList.remove('modal-open');
  loginModal.show();
});

// Listener para el botón de agregar imagen
const addImageBtn = document.getElementById('addImageBtn');
addImageBtn?.addEventListener('click', () => addImageModal.show());

// Listener para el formulario de agregar imagen
addImageForm?.addEventListener('submit', handleAddImage);

// Verificar si hay un token guardado
if (token) {
  loginBtn.classList.add('d-none');
  logoutBtn.classList.remove('d-none');
  if (adminControls) adminControls.classList.remove('d-none');
}

// Cargar imágenes al iniciar
loadImages();

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const response = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();
    if (response.ok) {
      token = data.token;
      localStorage.setItem('token', token);
      updateUserRole(); // Actualizar el rol después del login
      loginBtn.classList.add('d-none');
      logoutBtn.classList.remove('d-none');
      if (adminControls) adminControls.classList.remove('d-none');
      loginModal.hide();
      document.getElementById('loginForm').reset();
      loadImages(); // Recargar imágenes para actualizar los botones
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert('Error al iniciar sesión');
    console.error('Error:', err);
  }
}

function logout() {
  token = null;
  localStorage.removeItem('token');
  userRole = null; // Limpiar el rol al cerrar sesión
  loginBtn.classList.remove('d-none');
  logoutBtn.classList.add('d-none');
  if (adminControls) adminControls.classList.add('d-none');
  loadImages(); // Recargar imágenes para actualizar los botones
}

async function loadImages() {
  try {
    const response = await fetch(`${API_URL}/images`);
    const images = await response.json();
    renderImages(images);
  } catch (err) {
    console.error('Error loading images:', err);
  }
}

function getFullImageUrl(imageUrl) {
  if (imageUrl.startsWith('http')) {
    return imageUrl;
  }
  return `${BASE_URL}${imageUrl}`; // Usa la URL del backend dinámica
}

function renderImages(images) {
  imageContainer.innerHTML = images.map(image => `
    <div class="col">
      <div class="card shadow-sm ${image.is_blocked ? 'blocked' : ''} ${image.sold ? 'sold' : ''}">
        ${image.is_blocked ? '<div class="blocked-badge">Bloqueado</div>' : ''}
        ${image.sold ? '<div class="sold-badge">Vendido</div>' : ''}
        <img src="${getFullImageUrl(image.image_url)}" class="bd-placeholder-img card-img-top" width="100%" height="225" alt="${image.title}">
        <div class="card-body">
          <h5 class="card-title">${image.title}</h5>
          <p class="card-text">${image.description}</p>
          <div class="d-flex justify-content-between align-items-center">
            <div class="btn-group">
              <button type="button" class="btn btn-sm btn-outline-secondary view-btn" onclick="showImageModal('${getFullImageUrl(image.image_url)}')">Ver</button>
              <button type="button" class="btn btn-sm btn-outline-secondary copy-btn" data-url="${getFullImageUrl(image.image_url)}">Copiar URL</button>
              ${!image.sold ? 
                `<button type="button" class="btn btn-sm btn-outline-primary buy-btn" onclick="buyImage(${image.id})">Comprar</button>` 
                : ''}
              ${token && (userRole === 'admin' || userRole === 'super_admin') ? `
                <button type="button" class="btn btn-sm btn-outline-danger block-btn" onclick="toggleBlockImage(${image.id})">
                  ${image.is_blocked ? 'Desbloquear' : 'Bloquear'}
                </button>
                <button type="button" class="btn btn-sm btn-outline-warning sold-btn" onclick="toggleSoldStatus(${image.id})">
                  ${image.sold ? 'Marcar No Vendido' : 'Marcar Vendido'}
                </button>
                <button type="button" class="btn btn-sm btn-outline-info edit-btn" onclick="showEditModal(${image.id}, '${image.title}', '${image.description}', ${image.price})">
                  Editar
                </button>
                <button type="button" class="btn btn-sm btn-outline-danger delete-btn" onclick="deleteImage(${image.id})">
                  Eliminar
                </button>
              ` : ''}
            </div>
            <small class="text-body-secondary price-text">$${image.price}</small>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  // Agregar event listeners para los botones de copiar
  document.querySelectorAll('.copy-btn').forEach(button => {
    button.addEventListener('click', () => {
      const url = button.getAttribute('data-url');
      navigator.clipboard.writeText(url)
        .then(() => alert('URL copiada al portapapeles'))
        .catch(err => console.error('Error al copiar:', err));
    });
  });
}

async function handleAddImage(e) {
  e.preventDefault();
  const formData = new FormData();
  formData.append('title', addImageTitle.value);
  formData.append('description', addImageDescription.value);
  formData.append('price', addImagePrice.value);
  formData.append('image', addImageFile.files[0]);

  try {
    const response = await fetch(`${API_URL}/images`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });

    const data = await response.json();
    if (response.ok) {
      addImageModal.hide();
      addImageForm.reset();
      loadImages();
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert('Error al subir la imagen');
  }
}

function showImageModal(imageUrl) {
  document.getElementById('modalImage').src = imageUrl;
  viewImageModal.show();
}

async function buyImage(imageId) {
  try {
    const response = await fetch(`${API_URL}/images/${imageId}/buy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      loadImages(); // Recargar imágenes para mostrar el estado actualizado
    } else {
      const data = await response.json();
      alert(data.error || 'Error al procesar la compra');
    }
  } catch (err) {
    alert('Error al procesar la compra');
    console.error('Error:', err);
  }
}

async function toggleBlockImage(imageId) {
  if (!token || (userRole !== 'admin' && userRole !== 'super_admin')) {
    alert('Solo los administradores pueden bloquear/desbloquear imágenes');
    return;
  }

  try {
    const response = await fetch(`${API_URL}/images/${imageId}/toggle-block`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.ok) {
      loadImages();
    } else {
      const data = await response.json();
      alert(data.error);
    }
  } catch (err) {
    alert('Error al cambiar el estado de la imagen');
    console.error('Error:', err);
  }
}

async function toggleSoldStatus(imageId) {
  if (!token || (userRole !== 'admin' && userRole !== 'super_admin')) {
    alert('Solo los administradores pueden cambiar el estado de venta');
    return;
  }

  try {
    const response = await fetch(`${API_URL}/images/${imageId}/toggle-sold`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.ok) {
      loadImages();
    } else {
      const data = await response.json();
      alert(data.error);
    }
  } catch (err) {
    alert('Error al cambiar el estado de venta');
    console.error('Error:', err);
  }
}

function showEditModal(id, title, description, price) {
  currentEditId = id;
  document.getElementById('editTitle').value = title;
  document.getElementById('editDescription').value = description;
  document.getElementById('editPrice').value = price;
  editModal.show();
}

async function handleEdit(e) {
  e.preventDefault();
  
  if (!token || (userRole !== 'admin' && userRole !== 'super_admin')) {
    alert('Solo los administradores pueden editar imágenes');
    return;
  }

  const title = document.getElementById('editTitle').value;
  const description = document.getElementById('editDescription').value;
  const price = document.getElementById('editPrice').value;

  try {
    const response = await fetch(`${API_URL}/images/${currentEditId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ title, description, price })
    });

    if (response.ok) {
      editModal.hide();
      editForm.reset();
      loadImages();
    } else {
      const data = await response.json();
      alert(data.error);
    }
  } catch (err) {
    alert('Error al actualizar la imagen');
    console.error('Error:', err);
  }
}

async function deleteImage(imageId) {
  if (!token || (userRole !== 'admin' && userRole !== 'super_admin')) {
    alert('Solo los administradores pueden eliminar imágenes');
    return;
  }

  if (!confirm('¿Estás seguro de que quieres eliminar esta imagen? Esta acción no se puede deshacer.')) {
    return;
  }

  try {
    const response = await fetch(`${API_URL}/images/${imageId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.ok) {
      loadImages();
    } else {
      const data = await response.json();
      alert(data.error);
    }
  } catch (err) {
    alert('Error al eliminar la imagen');
    console.error('Error:', err);
  }
}

// Event listeners
editForm.addEventListener('submit', handleEdit);