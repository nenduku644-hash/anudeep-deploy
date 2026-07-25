const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3001/api';

async function test() {
  try {
    console.log('Testing Settings API...');
    let res = await fetch(`${BASE_URL}/settings`);
    if (!res.ok) throw new Error(`Settings GET failed: ${res.statusText}`);
    let settings = await res.json();
    console.log('Settings fetched:', JSON.stringify(settings, null, 2));

    console.log('\nTesting updating settings...');
    res = await fetch(`${BASE_URL}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inactivityTimeout: 400000, telegram: { chatId: 'test_chat_id' } })
    });
    if (!res.ok) throw new Error(`Settings PUT failed: ${res.statusText}`);
    settings = (await res.json()).settings;
    console.log('Updated settings:', JSON.stringify(settings, null, 2));

    console.log('\nTesting Products API...');
    res = await fetch(`${BASE_URL}/products`);
    if (!res.ok) throw new Error(`Products GET failed: ${res.statusText}`);
    let products = await res.json();
    console.log(`Products count: ${products.length}`);

    console.log('\nCreating test product...');
    const testProd = { id: 9999, name: 'Test Shirt', hsn: '1234', price: 99.99 };
    res = await fetch(`${BASE_URL}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testProd)
    });
    if (!res.ok) throw new Error(`Product POST failed: ${res.statusText}`);
    console.log('Product created successfully');

    console.log('\nFetching products again...');
    res = await fetch(`${BASE_URL}/products`);
    products = await res.json();
    console.log(`Products list:`, JSON.stringify(products, null, 2));

    console.log('\nDeleting test product...');
    res = await fetch(`${BASE_URL}/products/9999`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Product DELETE failed: ${res.statusText}`);
    console.log('Product deleted successfully');

    console.log('\nTesting Receivers API...');
    res = await fetch(`${BASE_URL}/receivers`);
    let receivers = await res.json();
    console.log(`Receivers count: ${receivers.length}`);

    console.log('\nCreating test receiver...');
    const testRec = { id: 8888, name: 'Test Receiver Name', address: '123 Test St', state: 'AP', gstin: '37AAAAA0000A1Z1', statecode: '37' };
    res = await fetch(`${BASE_URL}/receivers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testRec)
    });
    if (!res.ok) throw new Error(`Receiver POST failed: ${res.statusText}`);
    console.log('Receiver created successfully');

    console.log('\nFetching receivers again...');
    res = await fetch(`${BASE_URL}/receivers`);
    receivers = await res.json();
    console.log(`Receivers list:`, JSON.stringify(receivers, null, 2));

    console.log('\nDeleting test receiver...');
    res = await fetch(`${BASE_URL}/receivers/8888`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Receiver DELETE failed: ${res.statusText}`);
    console.log('Receiver deleted successfully');

    console.log('\nAll API integration tests passed successfully!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

test();
