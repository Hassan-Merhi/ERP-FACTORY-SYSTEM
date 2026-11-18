const form = document.getElementById('form');
const result = document.getElementById('result');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.textContent = 'Connecting…';
  const username = document.getElementById('username').value;
  const password = document.getElementById('password');
  const outcome = await window.offlinePc.connect(username, password.value);
  password.value = '';
  result.textContent = outcome.ok
    ? 'Connected. The first copy is downloading; you can close this window.'
    : 'Sign-in refused. Check the username and password and that the internet is up.';
});
