'use strict';

const assert = require('node:assert');
const { Ubicacion, ZonaCobertura, Pedido, EvaluadorPedido } = require('./logica-negocio.js');

const evaluador = new EvaluadorPedido(new ZonaCobertura());

/* ---------- Respuestas de ip-api.com (misma forma que devuelve la API real) ---------- */
const GEO = {
  sanJose: { status: 'success', country: 'Costa Rica', countryCode: 'CR', region: 'SJ', regionName: 'San José', city: 'San José', lat: 9.9281, lon: -84.0907, query: '190.10.10.10' },
  escazu: { status: 'success', country: 'Costa Rica', countryCode: 'CR', region: 'SJ', regionName: 'San José', city: 'Escazú', lat: 9.9187, lon: -84.1399, query: '190.10.10.20' },
  heredia: { status: 'success', country: 'Costa Rica', countryCode: 'CR', region: 'H', regionName: 'Heredia', city: 'Heredia', lat: 10.0024, lon: -84.1165, query: '190.10.10.30' },
  sanJoseCalifornia: { status: 'success', country: 'United States', countryCode: 'US', region: 'CA', regionName: 'California', city: 'San Jose', lat: 37.3382, lon: -121.8863, query: '8.8.4.4' },
  fallo: { status: 'fail', message: 'reserved range', query: '0.0.0.0' },
};

/* ---------- Pedidos de ejemplo ---------- */
const camisa = { sku: 'CAM-001', nombre: 'Camisa de algodón', precio: 15000, cantidad: 2, pesoKg: 0.4 };
const zapatos = { sku: 'ZAP-010', nombre: 'Zapatos deportivos', precio: 38000, cantidad: 1, pesoKg: 1.2 };
const mancuernas = { sku: 'MAN-020', nombre: 'Mancuernas 4 kg', precio: 9000, cantidad: 3, pesoKg: 4 };

const crearPedido = (extra) =>
  new Pedido({ id: 1, cliente: 'María Rodríguez', estado: 'pendiente', items: [camisa], ip: '190.10.10.10', ...extra });

/* ---------- Mini-framework de prueba ---------- */
let pruebas = 0;
function caso(titulo, fn) {
  console.log(`\n▶ ${titulo}`);
  fn();
  pruebas += 1;
  console.log('  ✔ OK');
}

// Ejecuta las dos etapas igual que lo hará el workflow
function procesar(pedido, respuestaGeo) {
  const previo = evaluador.evaluarPrevio(pedido);
  if (!previo.ok) return previo;
  return evaluador.evaluarConUbicacion(pedido, new Ubicacion(respuestaGeo));
}

function mostrar(r) {
  console.log(`  decisión: ${r.decision} | código: ${r.codigo} | HTTP: ${r.httpStatus}`);
  if (r.motivo) console.log(`  motivo: ${r.motivo}`);
  if (r.patch && r.patch.total != null) {
    console.log(`  subtotal: ₡${r.patch.subtotal} | envío: ₡${r.patch.costoEnvio} | total: ₡${r.patch.total}`);
  }
}

/* ---------- Casos ---------- */

caso('1. Cliente en el cantón central de San José -> aprobado, tarifa central', () => {
  const r = procesar(crearPedido(), GEO.sanJose);
  mostrar(r);
  assert.strictEqual(r.decision, 'APROBADO');
  assert.strictEqual(r.patch.costoEnvio, 2500);
  assert.strictEqual(r.patch.total, 30000 + 2500);
});

caso('2. Cliente en Escazú (provincia de San José) -> aprobado, tarifa del resto de la provincia', () => {
  const r = procesar(crearPedido(), GEO.escazu);
  mostrar(r);
  assert.strictEqual(r.decision, 'APROBADO');
  assert.strictEqual(r.patch.costoEnvio, 3500);
});

caso('3. Cliente en Heredia -> rechazado fuera de cobertura', () => {
  const r = procesar(crearPedido(), GEO.heredia);
  mostrar(r);
  assert.strictEqual(r.decision, 'RECHAZADO');
  assert.strictEqual(r.codigo, 'FUERA_DE_COBERTURA');
  assert.strictEqual(r.patch.estado, 'rechazado');
});

caso('4. "San Jose" de California NO es cobertura (se valida el país)', () => {
  const r = procesar(crearPedido({ ip: '8.8.4.4' }), GEO.sanJoseCalifornia);
  mostrar(r);
  assert.strictEqual(r.codigo, 'FUERA_DE_COBERTURA');
});

caso('5. Subtotal >= ₡50 000 -> envío gratis', () => {
  const r = procesar(crearPedido({ items: [camisa, zapatos] }), GEO.escazu); // 68 000
  mostrar(r);
  assert.strictEqual(r.patch.subtotal, 68000);
  assert.strictEqual(r.patch.costoEnvio, 0);
  assert.strictEqual(r.envio.gratis, true);
});

caso('6. Pedido pesado (12 kg) -> recargo por peso (7 kg extra x ₡300)', () => {
  const r = procesar(crearPedido({ items: [mancuernas] }), GEO.sanJose); // 27 000, 12 kg
  mostrar(r);
  assert.strictEqual(r.envio.recargoPeso, 2100);
  assert.strictEqual(r.patch.costoEnvio, 2500 + 2100);
});

caso('7. ERROR 1 - Pedido sin productos -> datos incompletos', () => {
  const r = procesar(crearPedido({ items: [] }), GEO.sanJose);
  mostrar(r);
  assert.strictEqual(r.codigo, 'DATOS_INCOMPLETOS');
  assert.strictEqual(r.httpStatus, 422);
});

caso('8. IP privada (192.168.1.10) -> rechazado sin llamar a la API', () => {
  const r = evaluador.evaluarPrevio(crearPedido({ ip: '192.168.1.10' }));
  mostrar(r);
  assert.strictEqual(r.codigo, 'IP_PRIVADA');
});

caso('9. IP con formato inválido o vacía -> rechazado', () => {
  const a = evaluador.evaluarPrevio(crearPedido({ ip: 'abc.def' }));
  const b = evaluador.evaluarPrevio(crearPedido({ ip: '' }));
  const c = evaluador.evaluarPrevio(crearPedido({ ip: '300.1.1.1' }));
  mostrar(a);
  assert.strictEqual(a.codigo, 'IP_INVALIDA');
  assert.strictEqual(b.codigo, 'IP_INVALIDA');
  assert.strictEqual(c.codigo, 'IP_INVALIDA');
});

caso('10. ERROR 2 - API externa falla -> el pedido NO se rechaza, queda pendiente', () => {
  const r = procesar(crearPedido(), GEO.fallo);
  mostrar(r);
  assert.strictEqual(r.decision, 'ERROR_SERVICIO');
  assert.strictEqual(r.httpStatus, 502);
  assert.strictEqual(r.patch.estado, 'pendiente');
});

caso('11. ERROR 2 (variante) - API caída sin respuesta (undefined)', () => {
  const r = procesar(crearPedido(), undefined);
  mostrar(r);
  assert.strictEqual(r.decision, 'ERROR_SERVICIO');
});

caso('12. Pedido ya aprobado no se procesa dos veces', () => {
  const r = procesar(crearPedido({ estado: 'aprobado' }), GEO.sanJose);
  mostrar(r);
  assert.strictEqual(r.decision, 'NO_PROCESABLE');
  assert.strictEqual(r.patch, null);
});

console.log(`\n✅ ${pruebas} casos probados correctamente.`);