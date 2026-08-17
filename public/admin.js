const $ = s => document.querySelector(s);
let data = null;


function token() {
  let t = localStorage.getItem('food_ai_admin_token');
  if (!t) {
    t = prompt('Enter ADMIN_TOKEN from your server .env file:') || '';
    if (t) localStorage.setItem('food_ai_admin_token', t);
  }
  return t;
}

async function api(url, options={}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token()}`, ...(options.headers||{}) },
  });
  const body = await res.json().catch(()=>({}));
  if (!res.ok) {
    if (res.status === 401) localStorage.removeItem('food_ai_admin_token');
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

function money(cents){return `$${(Number(cents||0)/100).toFixed(2)}`}
function esc(s){return String(s ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}

async function load() {
  try {
    const selected = $('#datePicker').value;
    data = await api(selected ? `/api/admin/dashboard?date=${encodeURIComponent(selected)}` : '/api/admin/dashboard');
    if (!$('#datePicker').value && data.date) $('#datePicker').value = data.date;
    render();
  } catch(e) { alert(e.message); }
}

function render() {
  $('#businessTitle').textContent = data.settings.business_name || 'Food AI Agent';
  const o = data.offerings || [], orders = data.orders || [];
  const prepared=o.reduce((a,x)=>a+x.prepared_qty,0), available=o.reduce((a,x)=>a+x.available_qty,0);
  const reserved=o.reduce((a,x)=>a+x.reserved_qty,0), sales=orders.filter(x=>x.status!=='cancelled').reduce((a,x)=>a+x.total_cents,0);
  $('#stats').innerHTML = [
    ['Prepared',prepared],['Available',available],['Reserved',reserved],['Order value',money(sales)]
  ].map(([k,v])=>`<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join('');

  $('#menuTable tbody').innerHTML = o.length ? o.map(x=>`<tr>
    <td><strong>${esc(x.item_name)}</strong><div class="muted">${esc(x.description||'')}</div></td>
    <td>${money(x.price_cents)}</td><td>${esc(x.portion_size||'—')}</td>
    <td><input class="qty-input" type="number" min="${x.reserved_qty+x.sold_qty}" value="${x.prepared_qty}" data-qty="${x.id}"></td>
    <td>${x.reserved_qty}</td><td>${x.sold_qty}</td><td><strong>${x.available_qty}</strong></td>
    <td><span class="badge ${!x.active?'bad':x.available_qty===0?'warn':'good'}">${!x.active?'OFF':x.available_qty===0?'SOLD OUT':'LIVE'}</span></td>
    <td><div class="actions"><button class="mini secondary" data-save="${x.id}">Save qty</button><button class="mini secondary" data-toggle="${x.id}" data-active="${x.active}">${x.active?'Disable':'Enable'}</button></div></td>
  </tr>`).join('') : `<tr><td colspan="9" class="muted">No dishes added for this date.</td></tr>`;

  $('#ordersTable tbody').innerHTML = orders.length ? orders.map(x=>`<tr>
    <td><strong>${esc(x.order_number)}</strong><div class="muted">${esc(x.phone)}</div></td>
    <td>${esc(x.customer_name||'—')}</td>
    <td class="items">${(x.order_items||[]).map(i=>`${i.quantity} × ${esc(i.item_name)}`).join('<br>')}</td>
    <td>${money(x.total_cents)}</td><td>${esc(String(x.pickup_time).replace('T',' ').slice(0,16))}</td>
    <td><select data-order-status="${x.id}" ${['completed','cancelled'].includes(x.status)?'disabled':''}>
      ${['confirmed','ready','completed','cancelled'].map(s=>`<option value="${s}" ${s===x.status?'selected':''}>${s}</option>`).join('')}
    </select></td>
  </tr>`).join('') : `<tr><td colspan="6" class="muted">No orders for this pickup date.</td></tr>`;

  for (const [k,v] of Object.entries(data.settings||{})) {
    const el = $(`#settingsForm [name="${k}"]`); if (el) el.value = v ?? '';
  }
}

$('#menuTable').addEventListener('click', async e => {
  const save=e.target.dataset.save, toggle=e.target.dataset.toggle;
  try {
    if (save) {
      const value=Number(document.querySelector(`[data-qty="${save}"]`).value);
      await api(`/api/admin/offerings/${save}`,{method:'PATCH',body:JSON.stringify({prepared_qty:value})}); toast('Quantity saved'); await load();
    }
    if (toggle) {
      await api(`/api/admin/offerings/${toggle}`,{method:'PATCH',body:JSON.stringify({active:e.target.dataset.active!=='true'})}); toast('Status updated'); await load();
    }
  } catch(err){alert(err.message)}
});

$('#ordersTable').addEventListener('change', async e => {
  const id=e.target.dataset.orderStatus; if(!id)return;
  try { await api(`/api/admin/orders/${id}/status`,{method:'PATCH',body:JSON.stringify({status:e.target.value})}); toast('Order updated'); await load(); }
  catch(err){alert(err.message);await load()}
});

$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault(); const obj=Object.fromEntries(new FormData(e.target));
  try { await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify(obj)}); toast('Settings saved'); await load(); }
  catch(err){alert(err.message)}
});

$('#addItemBtn').onclick=()=>{const f=$('#itemForm');f.reset();f.elements.service_date.value=$('#datePicker').value;$('#itemDialog').showModal()};
$('#cancelItemBtn').onclick=()=>$('#itemDialog').close();
$('#itemForm').addEventListener('submit',async e=>{
  e.preventDefault(); const f=Object.fromEntries(new FormData(e.target));
  const payload={...f,price_cents:Math.round(Number(f.price)*100),prepared_qty:Number(f.prepared_qty),active:true}; delete payload.price;
  try{await api('/api/admin/offerings',{method:'POST',body:JSON.stringify(payload)});$('#itemDialog').close();toast('Dish added');await load()}catch(err){alert(err.message)}
});
$('#refreshBtn').onclick=load;
$('#datePicker').onchange=load;
$('#tokenBtn').onclick=()=>{localStorage.removeItem('food_ai_admin_token');token();load()};
load();
