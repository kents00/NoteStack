import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthFailureNotification } from './authNotifications';

test('maps login 401 to friendly title and fallback message', () => {
  const result = buildAuthFailureNotification({
    mode: 'login',
    error: { status: 401, message: 'Login failed' },
  });

  assert.equal(result.title, 'Incorrect Credentials');
  assert.equal(result.message, 'The email or password is incorrect. Please try again.');
});

test('keeps backend login detail when available for 401', () => {
  const result = buildAuthFailureNotification({
    mode: 'login',
    error: { status: 401, message: 'Invalid email or password.' },
  });

  assert.equal(result.title, 'Incorrect Credentials');
  assert.equal(result.message, 'Invalid email or password.');
});

test('maps signup 409 to friendly duplicate-email title', () => {
  const result = buildAuthFailureNotification({
    mode: 'signup',
    error: { status: 409, message: 'Registration failed' },
  });

  assert.equal(result.title, 'Email Already Registered');
  assert.equal(result.message, 'This email is already registered. Try signing in instead.');
});

test('maps signup 422 to friendly validation title', () => {
  const result = buildAuthFailureNotification({
    mode: 'signup',
    error: { status: 422, message: 'Registration failed' },
  });

  assert.equal(result.title, 'Check Your Details');
  assert.equal(result.message, 'Please check the fields and try again.');
});

test('uses sign-in-required messaging when account was created but auto-login failed', () => {
  const result = buildAuthFailureNotification({
    mode: 'signup',
    accountCreated: true,
    error: { status: 401, message: 'Login failed' },
  });

  assert.equal(result.title, 'Sign In Required');
  assert.equal(
    result.message,
    'Your account was created, but automatic sign in failed. Please sign in with your new credentials.'
  );
});

test('uses default titles when status is unknown', () => {
  const result = buildAuthFailureNotification({
    mode: 'login',
    error: { status: 500, message: '' },
  });

  assert.equal(result.title, 'Sign In Failed');
  assert.equal(result.message, 'Authentication failed. Please try again.');
});
