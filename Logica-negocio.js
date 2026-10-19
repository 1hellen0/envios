'use strict';

/* ============================================================
 *  LÓGICA DE NEGOCIO - Pedidos con verificación de cobertura
 *  JavaScript puro, sin frameworks ni dependencias.
 *
 *  Este MISMO bloque se usa en:
 *   1) main.js (pruebas por consola, sin n8n)
 *   2) los nodos Code de n8n (se pega tal cual, sin cambios)
 * ============================================================ */

/* ---------- Utilidades ---------- */

// "San José" -> "san jose" (sin tildes, minúsculas, sin espacios extra)
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function esIpv4(ip) {
  const partes = String(ip).split('.');
  if (partes.length !== 4) return false;
  return partes.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function esIpv6(ip) {
  const texto = String(ip);
  return /^[0-9a-f:]+$/i.test(texto) && (texto.match(/:/g) || []).length >= 2;
}

function esIpValida(ip) {
  return typeof ip === 'string' && (esIpv4(ip.trim()) || esIpv6(ip.trim()));
}

// Rangos privados / locales: no se pueden geolocalizar
function esIpPrivada(ip) {
  const valor = String(ip).trim().toLowerCase();
  if (esIpv4(valor)) {
    const [a, b] = valor.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return valor === '::1' || valor.startsWith('fc') || valor.startsWith('fd') || valor.startsWith('fe80');
}

/* ---------- Clase Ubicacion ----------
 * Representa la respuesta de la API de geolocalización (ip-api.com).
 * Si la API falla o devuelve algo inesperado, esExitosa() es false.
 */
class Ubicacion {
  constructor(datos) {
    const d = datos && typeof datos === 'object' ? datos : {};
    this.status = d.status ?? 'fail';
    this.mensaje = d.message ?? null;
    this.ip = d.query ?? null;
    this.pais = d.country ?? null;
    this.codigoPais = d.countryCode ?? null;
    this.codigoRegion = d.region ?? null;
    this.region = d.regionName ?? null;
    this.ciudad = d.city ?? null;
    this.lat = d.lat ?? null;
    this.lon = d.lon ?? null;
  }

  // Regla: sin respuesta exitosa y sin país no hay ubicación utilizable.
  esExitosa() {
    return this.status === 'success' && Boolean(this.codigoPais);
  }

  descripcion() {
    const partes = [this.ciudad, this.region, this.pais].filter(Boolean);
    const sinRepetir = partes.filter((p, i) => i === 0 || normalizar(p) !== normalizar(partes[i - 1]));
    return sinRepetir.length ? sinRepetir.join(', ') : 'ubicación desconocida';
  }

  resumen() {
    return {
      pais: this.pais,
      codigoPais: this.codigoPais,
      provincia: this.region,
      ciudad: this.ciudad,
    };
  }
}

/* ---------- Clase ZonaCobertura ----------
 * Define dónde se despacha y cuánto cuesta el envío base.
 */
class ZonaCobertura {
  constructor(config = {}) {
    this.codigoPais = config.codigoPais ?? 'CR';
    this.nombrePais = config.nombrePais ?? 'Costa Rica';
    this.provincia = config.provincia ?? 'San José';
    this.codigoProvincia = config.codigoProvincia ?? 'SJ';
    this.cantonCentral = config.cantonCentral ?? 'San José';
    this.tarifaCentral = config.tarifaCentral ?? 2500; // colones
    this.tarifaResto = config.tarifaResto ?? 3500; // colones
  }

  // Regla de cobertura: país Y provincia deben coincidir.
  // (Se valida el país primero: "San Jose, California" NO es cobertura.)
  cubre(ubicacion) {
    if (!ubicacion.esExitosa()) return false;
    if (ubicacion.codigoPais !== this.codigoPais) return false;
    const mismaRegion = normalizar(ubicacion.region).includes(normalizar(this.provincia));
    const mismoCodigo = ubicacion.codigoRegion === this.codigoProvincia;
    return mismaRegion || mismoCodigo;
  }

  // Regla de tarifa: cantón central más barato que el resto de la provincia.
  tarifaBase(ubicacion) {
    const esCentral = normalizar(ubicacion.ciudad) === normalizar(this.cantonCentral);
    return esCentral ? this.tarifaCentral : this.tarifaResto;
  }

  motivoFueraDeZona(ubicacion) {
    return (
      `Solo realizamos envíos a la provincia de ${this.provincia}, ${this.nombrePais}. ` +
      `Tu ubicación detectada es: ${ubicacion.descripcion()}.`
    );
  }
}

/* ---------- Clase Pedido ----------
 * Entidad principal. Conoce sus items y sabe validarse y calcular su envío.
 */
class Pedido {
  static ENVIO_GRATIS_DESDE = 50000; // colones (subtotal)
  static KG_INCLUIDOS = 5; // kg sin recargo
  static RECARGO_POR_KG = 300; // colones por kg adicional (se redondea hacia arriba)

  constructor(datos = {}) {
    this.id = datos.id ?? null;
    this.cliente = datos.cliente ?? null;
    this.correo = datos.correo ?? null;
    this.ip = datos.ip ?? null;
    this.estado = datos.estado ?? 'pendiente';
    this.items = Array.isArray(datos.items) ? datos.items : [];
  }

  subtotal() {
    return this.items.reduce((suma, it) => suma + Number(it.precio) * Number(it.cantidad), 0);
  }

  pesoTotalKg() {
    return this.items.reduce((suma, it) => suma + Number(it.pesoKg ?? 0) * Number(it.cantidad), 0);
  }

  // Regla: solo se procesan pedidos pendientes (evita procesar dos veces).
  puedeProcesarse() {
    return this.estado === 'pendiente';
  }

  // Regla: el pedido debe traer datos completos. Devuelve la lista de problemas.
  validar() {
    const errores = [];
    if (!this.cliente || !String(this.cliente).trim()) errores.push('falta el nombre del cliente');
    if (!this.items.length) errores.push('el pedido no tiene productos');
    this.items.forEach((it, i) => {
      const n = i + 1;
      if (!it.nombre) errores.push(`el producto ${n} no tiene nombre`);
      if (!(Number(it.precio) >= 0) || it.precio === undefined || it.precio === null) {
        errores.push(`el producto ${n} tiene un precio inválido`);
      }
      if (!(Number(it.cantidad) > 0)) errores.push(`el producto ${n} tiene una cantidad inválida`);
    });
    return errores;
  }

  // Cálculo del envío: tarifa por zona + recargo por peso; gratis si el subtotal es alto.
  calcularCostoEnvio(zona, ubicacion) {
    const subtotal = this.subtotal();
    if (subtotal >= Pedido.ENVIO_GRATIS_DESDE) {
      return { costo: 0, tarifaBase: 0, recargoPeso: 0, gratis: true };
    }
    const tarifaBase = zona.tarifaBase(ubicacion);
    const kgExtra = Math.max(0, this.pesoTotalKg() - Pedido.KG_INCLUIDOS);
    const recargoPeso = Math.ceil(kgExtra) * Pedido.RECARGO_POR_KG;
    return { costo: tarifaBase + recargoPeso, tarifaBase, recargoPeso, gratis: false };
  }
}

/* ---------- Clase EvaluadorPedido ----------
 * Orquesta las reglas y produce el resultado que n8n usa para decidir
 * (rama del IF, respuesta HTTP y datos del PATCH a JSON Server).
 */
class EvaluadorPedido {
  constructor(zona = new ZonaCobertura()) {
    this.zona = zona;
  }

  _rechazar(codigo, motivo, httpStatus) {
    return {
      ok: false,
      decision: 'RECHAZADO',
      codigo,
      motivo,
      httpStatus,
      patch: {
        estado: 'rechazado',
        motivoRechazo: motivo,
        codigoRechazo: codigo,
        costoEnvio: null,
        total: null,
        procesadoEn: new Date().toISOString(),
      },
    };
  }

  // Paso 1 (ANTES de llamar a la API externa): reglas que no necesitan geolocalización.
  evaluarPrevio(pedido) {
    if (!pedido.puedeProcesarse()) {
      return {
        ok: false,
        decision: 'NO_PROCESABLE',
        codigo: 'PEDIDO_NO_PROCESABLE',
        motivo: `El pedido ya está en estado "${pedido.estado}" y no puede procesarse de nuevo.`,
        httpStatus: 409,
        patch: null, // no se toca el pedido
      };
    }

    const errores = pedido.validar();
    if (errores.length) {
      return this._rechazar('DATOS_INCOMPLETOS', `Datos incompletos: ${errores.join('; ')}.`, 422);
    }

    if (!esIpValida(pedido.ip)) {
      return this._rechazar('IP_INVALIDA', 'La IP del cliente falta o no tiene un formato válido.', 422);
    }

    if (esIpPrivada(pedido.ip)) {
      return this._rechazar(
        'IP_PRIVADA',
        'La IP del cliente es privada o local y no se puede ubicar geográficamente.',
        422
      );
    }

    return { ok: true, decision: 'CONTINUAR', codigo: 'OK', motivo: null, httpStatus: 200, patch: null };
  }

  // Paso 2 (DESPUÉS de la API externa): cobertura y costo de envío.
  evaluarConUbicacion(pedido, ubicacion) {
    // Situación inesperada: el servicio externo falló o respondió algo inutilizable.
    // El pedido NO se rechaza por un problema nuestro: queda pendiente para reintentar.
    if (!ubicacion.esExitosa()) {
      const detalle = ubicacion.mensaje ? ` (${ubicacion.mensaje})` : '';
      return {
        ok: false,
        decision: 'ERROR_SERVICIO',
        codigo: 'SERVICIO_GEOLOCALIZACION_NO_DISPONIBLE',
        motivo: `No se pudo verificar la ubicación${detalle}. El pedido queda pendiente para reintentar.`,
        httpStatus: 502,
        patch: {
          estado: 'pendiente',
          ultimoError: `Geolocalización no disponible${detalle}`,
          intentoEn: new Date().toISOString(),
        },
      };
    }

    if (!this.zona.cubre(ubicacion)) {
      return this._rechazar('FUERA_DE_COBERTURA', this.zona.motivoFueraDeZona(ubicacion), 422);
    }

    const envio = pedido.calcularCostoEnvio(this.zona, ubicacion);
    const subtotal = pedido.subtotal();
    return {
      ok: true,
      decision: 'APROBADO',
      codigo: 'APROBADO',
      motivo: null,
      httpStatus: 200,
      envio,
      patch: {
        estado: 'aprobado',
        motivoRechazo: null,
        codigoRechazo: null,
        subtotal,
        costoEnvio: envio.costo,
        total: subtotal + envio.costo,
        ubicacionDetectada: ubicacion.resumen(),
        ultimoError: null,
        procesadoEn: new Date().toISOString(),
      },
    };
  }
}

// Exportación solo cuando se usa con Node (main.js). En n8n este bloque se ignora.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Ubicacion, ZonaCobertura, Pedido, EvaluadorPedido, esIpValida, esIpPrivada, normalizar };
}