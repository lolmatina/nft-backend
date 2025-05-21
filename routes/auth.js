const router = require('express').Router();
const { query } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const authenticateToken = require('../middleware/authenticateToken');
require('dotenv').config();


let twilioClient;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} else {
  console.warn('Twilio credentials not found in .env. SMS functionality will be disabled.');
}


router.post('/register', async (req, res) => {
  const { email, password, username, contact_wallet_address } = req.body;

  if (!email || !password) {
    return res.status(400).json({ msg: 'Please provide email and password.' });
  }

  try {
    
    const userCheck = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ msg: 'User with this email already exists.' });
    }

    if (username) {
        const usernameCheck = await query('SELECT * FROM users WHERE username = $1', [username]);
        if (usernameCheck.rows.length > 0) {
            return res.status(400).json({ msg: 'Username already taken.'});
        }
    }

    
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    
    const newUserResult = await query(
      'INSERT INTO users (email, hashed_password, username, contact_wallet_address) VALUES ($1, $2, $3, $4) RETURNING id, email, username, created_at',
      [email, hashedPassword, username, contact_wallet_address]
    );
    const newUser = newUserResult.rows[0];

    
    if (contact_wallet_address) {
        try {
            await query(
                'INSERT INTO user_wallets (user_id, wallet_address, is_primary) VALUES ($1, $2, $3)',
                [newUser.id, contact_wallet_address, true]
            );
        } catch (walletError) {
            
            console.error('Error linking initial wallet during registration:', walletError.message);
            if (walletError.code === '23505') { 
                
                
                
                console.warn(`Wallet ${contact_wallet_address} might already be linked elsewhere or failed primary constraint.`);
            }
        }
    }

    
    const payload = { user: { id: newUser.id } };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRATION || '3h' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: (parseInt(process.env.JWT_EXPIRATION_MS) || 3 * 60 * 60 * 1000)
    });

    res.status(201).json({
      msg: 'User registered successfully. You can now enable 2FA in your profile.',
      user: { id: newUser.id, email: newUser.email, username: newUser.username },
    });

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).send('Server error during registration.');
  }
});


router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ msg: 'Email and password are required' });
  }

  try {
    const userResult = await query('SELECT id, email, hashed_password, username, phone_number, is_2fa_enabled, contact_wallet_address FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ msg: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    const isMatch = await bcrypt.compare(password, user.hashed_password);
    if (!isMatch) {
      return res.status(401).json({ msg: 'Invalid credentials' });
    }

    if (user.is_2fa_enabled) {
      if (!twilioClient || !process.env.TWILIO_VERIFY_SERVICE_SID) {
        console.error('2FA enabled for user but Twilio is not configured.');
        return res.status(500).json({ msg: '2FA mechanism is not available. Contact support.' });
      }
      if (!user.phone_number) {
        console.error(`User ${user.id} has 2FA enabled but no phone number.`);
        return res.status(500).json({ msg: '2FA configuration error for your account. Contact support.' });
      }
      try {
        await twilioClient.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
          .verifications
          .create({ to: user.phone_number, channel: 'sms' });
        return res.status(200).json({ 
          message: '2FA code sent. Please verify.', 
          twoFactorAuthRequired: true, 
          userId: user.id
        });
      } catch (twilioError) {
        console.error('Twilio - Failed to send 2FA code during login:', twilioError);
        return res.status(500).json({ msg: 'Failed to send 2FA code. Please try again.' });
      }
    } else {
      
      const payload = { user: { id: user.id, email: user.email, username: user.username } };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRATION || '1h' });
      
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: (parseInt(process.env.JWT_EXPIRATION_MS) || 1 * 60 * 60 * 1000)
      });
      
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          contact_wallet_address: user.contact_wallet_address,
          is_2fa_enabled: user.is_2fa_enabled
        }
      });
    }
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).send('Server error');
  }
});


router.post('/verify-2fa', async (req, res) => {
  const { userId, code } = req.body;

  if (!userId || !code) {
    return res.status(400).json({ msg: 'User ID and 2FA code are required.' });
  }
  if (!twilioClient || !process.env.TWILIO_VERIFY_SERVICE_SID) {
    return res.status(500).json({ msg: '2FA verification service not configured.' });
  }

  try {
    const userResult = await query('SELECT id, email, username, phone_number, contact_wallet_address, is_2fa_enabled FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ msg: 'User not found for 2FA verification.' });
    }
    const user = userResult.rows[0];

    if (!user.is_2fa_enabled || !user.phone_number) {
      return res.status(400).json({ msg: '2FA not enabled or phone number missing for this user.' });
    }

    const verificationCheck = await twilioClient.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks
      .create({ to: user.phone_number, code: code });

    if (verificationCheck.status === 'approved') {
      const payload = { user: { id: user.id, email: user.email, username: user.username } };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRATION || '1h' });

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: (parseInt(process.env.JWT_EXPIRATION_MS) || 1 * 60 * 60 * 1000)
      });
      
      res.json({
        message: '2FA successful. Logged in.',
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          contact_wallet_address: user.contact_wallet_address,
          is_2fa_enabled: user.is_2fa_enabled
        }
      });
    } else {
      return res.status(401).json({ msg: 'Invalid 2FA code.' });
    }
  } catch (err) {
    console.error('2FA verification error:', err);
    if (err.code === 60202 && err.message.includes("Max check attempts reached")) {
        return res.status(429).json({ msg: 'Too many 2FA verification attempts. Please try logging in again to get a new code.' });
    }
    if (err.status === 404 && err.code === 20404) {
         return res.status(400).json({ msg: 'Verification expired or not found. Please try logging in again.' });
    }
    res.status(500).json({ msg: 'Server error during 2FA verification.' });
  }
});


router.post('/2fa/enable-request', authenticateToken, async (req, res) => {
  const { phone_number } = req.body;
  const userId = req.user.id;

  if (!phone_number) {
    return res.status(400).json({ msg: 'Phone number is required.' });
  }
  if (!twilioClient || !process.env.TWILIO_VERIFY_SERVICE_SID) {
    return res.status(500).json({ msg: '2FA setup service not configured.' });
  }
  if (!/^\+?[1-9]\d{1,14}$/.test(phone_number)) {
    return res.status(400).json({ msg: 'Invalid phone number format. Please use E.164 format (e.g., +1234567890).' });
  }

  try {
    await query('UPDATE users SET phone_number_pending_verification = $1 WHERE id = $2', [phone_number, userId]);
    
    await twilioClient.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications
      .create({ to: phone_number, channel: 'sms' });
      
    res.json({ message: `Verification code sent to ${phone_number}. Please verify to enable 2FA.` });
  } catch (err) {
    console.error('2FA enable request error:', err);
    if (err.code === 60203 || (err.status === 400 && err.message && err.message.toLowerCase().includes("invalid parameter `to`"))) {
        await query('UPDATE users SET phone_number_pending_verification = NULL WHERE id = $1', [userId]);
        return res.status(400).json({ msg: 'The provided phone number is invalid. Please check and try again.' });
    }
    res.status(500).json({ msg: 'Failed to send verification code.' });
  }
});


router.post('/2fa/enable-confirm', authenticateToken, async (req, res) => {
  const { code } = req.body;
  const userId = req.user.id;

  if (!code) {
    return res.status(400).json({ msg: 'Verification code is required.' });
  }
  if (!twilioClient || !process.env.TWILIO_VERIFY_SERVICE_SID) {
    return res.status(500).json({ msg: '2FA setup service not configured.' });
  }

  try {
    const userResult = await query('SELECT phone_number_pending_verification FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0 || !userResult.rows[0].phone_number_pending_verification) {
      return res.status(400).json({ msg: 'No phone number pending verification. Please request to enable 2FA first.' });
    }
    const phoneNumberToVerify = userResult.rows[0].phone_number_pending_verification;

    const verificationCheck = await twilioClient.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks
      .create({ to: phoneNumberToVerify, code: code });

    if (verificationCheck.status === 'approved') {
      await query('UPDATE users SET phone_number = $1, is_2fa_enabled = TRUE, phone_number_pending_verification = NULL WHERE id = $2', [phoneNumberToVerify, userId]);
      res.json({ message: '2FA enabled successfully.' });
    } else {
      res.status(400).json({ msg: 'Invalid verification code.' });
    }
  } catch (err) {
    console.error('2FA enable confirm error:', err);
     if (err.code === 60202 && err.message.includes("Max check attempts reached")) {
        return res.status(429).json({ msg: 'Too many 2FA verification attempts. Please request a new code to enable 2FA.' });
    }
    res.status(500).json({ msg: 'Failed to confirm 2FA.' });
  }
});


router.post('/2fa/disable', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    await query('UPDATE users SET is_2fa_enabled = FALSE, phone_number_pending_verification = NULL WHERE id = $1', [userId]);
    res.json({ message: '2FA disabled successfully.' });
  } catch (err) {
    console.error('2FA disable error:', err);
    res.status(500).json({ msg: 'Failed to disable 2FA.' });
  }
});


router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userResult = await query('SELECT id, email, username, profile_picture_url, phone_number, is_2fa_enabled, contact_wallet_address, created_at FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ msg: 'User not found.' });
    }
    res.json(userResult.rows[0]);
  } catch (err) {
    console.error('Get me error:', err.message);
    res.status(500).send('Server error.');
  }
});


router.post('/logout', (req, res) => {
  res.cookie('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    expires: new Date(0)
  });
  res.json({ msg: 'Logged out successfully' });
});

module.exports = router; 