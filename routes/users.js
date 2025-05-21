const router = require('express').Router();
const { query } = require('../db');
const bcrypt = require('bcrypt');
const authenticateToken = require('../middleware/authenticateToken');




router.get('/me/drafts', authenticateToken, async (req, res) => {
  console.log('[DEBUG] Entered /me/drafts route in users.js. req.user:', req.user);
  try {
    const userId = req.user ? req.user.id : undefined;
    console.log('[DEBUG] User ID in /me/drafts:', userId);

    if (!userId) {
      console.error('[DEBUG] /me/drafts: userId is undefined. req.user was:', req.user);
      return res.status(401).json({ msg: 'User not authenticated or user ID is missing.' });
    }

    console.log(`[DEBUG] Fetching drafts for userId ${userId}`);
    const { rows } = await query(
      "SELECT id, creator_user_id, name, symbol, description, image_url, metadata_json_url, price, attributes, collection_name, status, created_at, updated_at FROM draft_nfts WHERE creator_user_id = $1 AND status = 'draft' ORDER BY created_at DESC",
      [userId]
    );
    console.log(`[DEBUG] Drafts query returned ${rows.length} rows for userId ${userId}`);
    res.json(rows);

  } catch (err) {
    const currentUserId = req.user ? req.user.id : 'undefined_user';
    console.error(`[DEBUG] Error in /me/drafts for user ${currentUserId}:`, err.message, err.stack);
    res.status(500).send('Server error in /me/drafts (restored)');
  }
});


router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userResult = await query(
      'SELECT id, email, username, contact_wallet_address, phone_number, is_2fa_enabled, profile_picture_url, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ msg: 'User not found.' }); 
    }
    res.json(userResult.rows[0]);
  } catch (err) {
    console.error('Error fetching current user details:', err.message, err.stack);
    res.status(500).json({ msg: 'Server error while fetching user details.' });
  }
});


router.put('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { username, phone_number, is_2fa_enabled } = req.body;

    
    const fieldsToUpdate = {};
    if (username !== undefined) fieldsToUpdate.username = username;
    if (phone_number !== undefined) fieldsToUpdate.phone_number = phone_number;
    if (is_2fa_enabled !== undefined) fieldsToUpdate.is_2fa_enabled = is_2fa_enabled;

    if (Object.keys(fieldsToUpdate).length === 0) {
      return res.status(400).json({ msg: 'No fields provided for update.' });
    }

    const setClauses = Object.keys(fieldsToUpdate).map((key, index) => {
      return `${key} = $${index + 1}`;
    }).join(', ');
    const values = Object.values(fieldsToUpdate);

    const updateQuery = `UPDATE users SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length + 1} RETURNING id, email, username, contact_wallet_address, phone_number, is_2fa_enabled, profile_picture_url, created_at, updated_at`;
    values.push(userId);

    const { rows } = await query(updateQuery, values);

    if (rows.length === 0) {
      return res.status(404).json({ msg: 'User not found or update failed.' });
    }

    res.json({ user: rows[0], msg: 'User details updated successfully.' });

  } catch (err) {
    console.error('Error updating user details:', err.message, err.stack);
    
    if (err.code === '23505' && err.constraint && err.constraint.includes('username')) {
        return res.status(409).json({ msg: 'Username already taken.' });
    }
    res.status(500).json({ msg: 'Server error while updating user details.' });
  }
});


router.get('/me/wallets', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const walletsResult = await query(
      'SELECT wallet_address, is_primary, created_at AS linked_at FROM user_wallets WHERE user_id = $1 ORDER BY is_primary DESC, created_at DESC',
      [userId]
    );
    res.json(walletsResult.rows);
  } catch (err) {
    console.error('Error fetching user wallets:', err.message, err.stack);
    res.status(500).json({ msg: 'Server error while fetching user wallets.' });
  }
});


router.post('/me/wallets', authenticateToken, async (req, res) => {
  const { wallet_address } = req.body;
  const userId = req.user.id;

  if (!wallet_address) {
    return res.status(400).json({ msg: 'Wallet address is required.' });
  }

  if (!userId) {
    
    return res.status(401).json({ msg: 'User not authenticated.' });
  }

  try {
    await query('BEGIN');

    
    const existingLinkToCurrentUser = await query(
      'SELECT * FROM user_wallets WHERE user_id = $1 AND wallet_address = $2',
      [userId, wallet_address]
    );
    if (existingLinkToCurrentUser.rows.length > 0) {
      await query('COMMIT'); 
      return res.status(200).json({ msg: 'Wallet already linked to your account.' });
    }

    
    const existingLinkToAnotherUser = await query(
      'SELECT user_id FROM user_wallets WHERE wallet_address = $1 AND user_id != $2',
      [wallet_address, userId]
    );
    if (existingLinkToAnotherUser.rows.length > 0) {
      await query('ROLLBACK');
      return res.status(409).json({ msg: 'This wallet address is already associated with another user account.' });
    }

    
    await query(
      'INSERT INTO user_wallets (user_id, wallet_address) VALUES ($1, $2)',
      [userId, wallet_address]
    );

    await query('COMMIT');
    res.status(201).json({ msg: 'Wallet linked successfully to your account.' });

  } catch (err) {
    await query('ROLLBACK');
    console.error('Error linking wallet to user:', err.message, err.stack);
    
    
    
    
    if (err.code === '23505') { 
        
        
        
        return res.status(409).json({ msg: 'This wallet address might already be in use or a database error occurred.' });
    }
    res.status(500).json({ msg: 'Server error while linking wallet.' });
  }
});


router.put('/me/wallets/:walletAddress/set-primary', authenticateToken, async (req, res) => {
  const { walletAddress } = req.params;
  const userId = req.user.id;

  try {
    await query('BEGIN');

    
    const walletLink = await query('SELECT * FROM user_wallets WHERE user_id = $1 AND wallet_address = $2', [userId, walletAddress]);
    if (walletLink.rows.length === 0) {
      await query('ROLLBACK');
      return res.status(404).json({ msg: 'Wallet not linked to this user or not found.' });
    }

    
    await query('UPDATE user_wallets SET is_primary = FALSE WHERE user_id = $1', [userId]);

    
    await query('UPDATE user_wallets SET is_primary = TRUE WHERE user_id = $1 AND wallet_address = $2', [userId, walletAddress]);

    
    await query('UPDATE users SET contact_wallet_address = $1 WHERE id = $2', [walletAddress, userId]);

    await query('COMMIT');
    res.json({ msg: `Wallet ${walletAddress} set as primary successfully.` });

  } catch (err) {
    await query('ROLLBACK');
    console.error('Error setting primary wallet:', err.message, err.stack);
    res.status(500).json({ msg: 'Server error while setting primary wallet.' });
  }
});


router.delete('/me/wallets/:walletAddress', authenticateToken, async (req, res) => {
  const { walletAddress } = req.params;
  const userId = req.user.id;

  try {
    await query('BEGIN');

    
    const walletLinkResult = await query('SELECT is_primary FROM user_wallets WHERE user_id = $1 AND wallet_address = $2', [userId, walletAddress]);
    if (walletLinkResult.rows.length === 0) {
      await query('ROLLBACK');
      return res.status(404).json({ msg: 'Wallet not linked to this user or not found.' });
    }
    const wasPrimary = walletLinkResult.rows[0].is_primary;

    
    const deleteResult = await query('DELETE FROM user_wallets WHERE user_id = $1 AND wallet_address = $2', [userId, walletAddress]);
    if (deleteResult.rowCount === 0) {
      
      await query('ROLLBACK');
      return res.status(404).json({ msg: 'Wallet not found or already unlinked.' });
    }

    
    if (wasPrimary) {
      await query('UPDATE users SET contact_wallet_address = NULL WHERE id = $1 AND contact_wallet_address = $2', [userId, walletAddress]);
      
      
    }

    await query('COMMIT');
    res.json({ msg: `Wallet ${walletAddress} unlinked successfully.` });

  } catch (err) {
    await query('ROLLBACK');
    console.error('Error unlinking wallet:', err.message, err.stack);
    res.status(500).json({ msg: 'Server error while unlinking wallet.' });
  }
});




router.get('/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    const userWalletResult = await query('SELECT user_id FROM user_wallets WHERE wallet_address = $1', [walletAddress]);
    if (userWalletResult.rows.length === 0) {
      return res.status(404).json({ msg: 'No user associated with this wallet address' });
    }
    const userId = userWalletResult.rows[0].user_id;

    const userResult = await query('SELECT id, email, username, contact_wallet_address, phone_number, is_2fa_enabled, profile_picture_url, created_at FROM users WHERE id = $1', [userId]);
    
    if (userResult.rows.length === 0) {
      
      return res.status(404).json({ msg: 'User not found' });
    }
    res.json(userResult.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});


router.get('/:walletAddress/nfts', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    const userWalletResult = await query('SELECT user_id FROM user_wallets WHERE wallet_address = $1', [walletAddress]);
    if (userWalletResult.rows.length === 0) {
      
      
      return res.json([]); 
    }
    const userId = userWalletResult.rows[0].user_id;

    
    
    const { rows } = await query(
      'SELECT id, mint_address, name, image_url, price FROM nfts WHERE owner_user_id = $1 AND is_listed = TRUE ORDER BY created_at DESC',
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(`Error fetching NFTs for user associated with wallet ${req.params.walletAddress}:`, err.message);
    res.status(500).send('Server error');
  }
});


router.get('/:walletAddress/drafts', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    const userWalletResult = await query('SELECT user_id FROM user_wallets WHERE wallet_address = $1', [walletAddress]);
    if (userWalletResult.rows.length === 0) {
      return res.json([]); 
    }
    const userId = userWalletResult.rows[0].user_id;
    
    
    const { rows } = await query(
      "SELECT id, creator_user_id, name, symbol, description, image_url, metadata_json_url, price, attributes, collection_name, status, created_at, updated_at FROM draft_nfts WHERE creator_user_id = $1 AND status = 'draft' ORDER BY created_at DESC",
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(`Error fetching draft NFTs for user associated with wallet ${req.params.walletAddress}:`, err.message);
    res.status(500).send('Server error');
  }
});


router.post('/', async (req, res) => {
  const { email, password, username, contact_wallet_address, phone_number } = req.body;

  if (!email || !password) {
    return res.status(400).json({ msg: 'Email and password are required' });
  }

  try {
    
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ msg: 'User already exists with this email' });
    }

    
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    
    await query('BEGIN');

    
    const newUserResult = await query(
      `INSERT INTO users (email, hashed_password, username, contact_wallet_address, phone_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, username, contact_wallet_address, phone_number, is_2fa_enabled, created_at`,
      [email, hashedPassword, username, contact_wallet_address, phone_number]
    );
    const newUser = newUserResult.rows[0];

    
    if (contact_wallet_address) {
      
      const existingWalletLink = await query(
        'SELECT user_id FROM user_wallets WHERE wallet_address = $1 AND user_id != $2',
        [contact_wallet_address, newUser.id]
      );
      if (existingWalletLink.rows.length > 0) {
        await query('ROLLBACK'); 
        return res.status(409).json({ msg: 'This wallet address is already associated with another user account.' });
      }
      
      
      await query(
        `INSERT INTO user_wallets (user_id, wallet_address)
         VALUES ($1, $2)
         ON CONFLICT (wallet_address) DO UPDATE SET user_id = EXCLUDED.user_id`,
        [newUser.id, contact_wallet_address]
      );
    }

    await query('COMMIT');
    
    
    res.status(201).json({ user: newUser, msg: "User registered successfully. Please login." });

  } catch (err) {
    await query('ROLLBACK');
    console.error(err.message);
    if (err.code === '23505' && err.constraint === 'users_email_key') { 
        return res.status(409).json({ msg: 'Email already exists.' });
    }
     if (err.code === '23505' && err.constraint === 'user_wallets_wallet_address_key') {
        
        return res.status(409).json({ msg: 'This wallet address is already linked to an account.' });
    }
    res.status(500).send('Server error');
  }
});

module.exports = router; 