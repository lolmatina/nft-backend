const router = require('express').Router();
const { query } = require('../db'); 
const { getNFTMetadata, verifyNFTOwner, getUmi } = require('../solana/solanaUtils'); 
const authenticateToken = require('../middleware/authenticateToken'); 

// Get ALL NFTS (listed)
router.get('/', async (req, res) => {
  try {
    const { name: searchName } = req.query; 
    let queryString = `
      SELECT 
        id, 
        mint_address, 
        name, 
        image_url, 
        price, 
        is_listed,
        owner_wallet_address,
        updated_at
      FROM nfts 
      WHERE (
        is_listed = TRUE 
        OR (
          is_listed = FALSE 
          AND updated_at > NOW() - INTERVAL '7 days'
        )
      )`;
    const queryParams = [];

    if (searchName) {
      queryString += ' AND name ILIKE $1'; 
      queryParams.push(`%${searchName}%`); 
    }

    queryString += ' ORDER BY is_listed DESC, updated_at DESC';

    
    
    const { rows } = await query(queryString, queryParams.length > 0 ? queryParams : undefined);
    
    res.json(rows);
  } catch (err) {
    console.error('Error fetching NFTs:', err.message); 
    
    res.status(500).json({ msg: 'Server error while fetching NFTs', error: err.message });
  }
});


// Get NFT by DB ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query('SELECT n.*, u.username as owner_username, uw.wallet_address as primary_contact_wallet FROM nfts n LEFT JOIN users u ON n.owner_user_id = u.id LEFT JOIN user_wallets uw ON u.id = uw.user_id AND uw.is_primary = TRUE WHERE n.id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ msg: 'NFT not found by DB ID' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});


// Get NFT by mint address
router.get('/mint/:mintAddress', async (req, res) => {
  try {
    const { mintAddress } = req.params;
    let { rows } = await query('SELECT n.*, u.username as owner_username, uw.wallet_address as primary_contact_wallet FROM nfts n LEFT JOIN users u ON n.owner_user_id = u.id LEFT JOIN user_wallets uw ON u.id = uw.user_id AND uw.is_primary = TRUE WHERE n.mint_address = $1', [mintAddress]);
    
    let dbNft = null;
    if (rows.length > 0) {
      dbNft = rows[0];
    }

    
    
    const solanaMetadata = await getNFTMetadata(mintAddress);

    if (solanaMetadata && solanaMetadata.error) {
      
      if (!dbNft) {
        return res.status(solanaMetadata.status || 404).json({ msg: solanaMetadata.error });
      }
      
      console.warn(`Error fetching live Solana metadata for ${mintAddress}: ${solanaMetadata.error}. Serving DB data.`);
      return res.json({ ...dbNft, solana_fetch_error: solanaMetadata.error });
    }

    if (!solanaMetadata && !dbNft) {
      return res.status(404).json({ msg: `NFT with mint ${mintAddress} not found in database or on-chain.` });
    }

    
    const combinedData = {
      ...(solanaMetadata || {}), 
      ...(dbNft || {}), 
      
      name: solanaMetadata?.name || dbNft?.name,
      image_url: solanaMetadata?.image || dbNft?.image_url, 
      description: solanaMetadata?.description || dbNft?.description, 
      attributes: solanaMetadata?.attributes || dbNft?.attributes,
      
      mint_address: mintAddress,
      
    };
    
    
    if (!dbNft && solanaMetadata) {
        combinedData.is_listed = false; 
        combinedData.price = null;
    }

    res.json(combinedData);

  } catch (err) {
    console.error(`Error in GET /api/nfts/mint/${req.params.mintAddress}:`, err.message);
    res.status(500).send('Server error');
  }
});




router.post('/mint/:mintAddress/buy', async (req, res) => {
  const { mintAddress } = req.params;
  const { buyer_wallet_address, transaction_signature, paid_price } = req.body;

  if (!buyer_wallet_address || !transaction_signature || paid_price === undefined) {
    return res.status(400).json({ msg: 'Missing buyer_wallet_address, transaction_signature, or paid_price' });
  }

  const client = await query('BEGIN'); 

  try {
    
    const nftResult = await query('SELECT id, owner_wallet_address, owner_user_id, price FROM nfts WHERE mint_address = $1 AND is_listed = TRUE FOR UPDATE', [mintAddress]);
    
    if (nftResult.rows.length === 0) {
      await query('ROLLBACK');
      return res.status(404).json({ msg: 'NFT not found, not listed, or already sold.' });
    }

    const nft = nftResult.rows[0];
    const seller_wallet_address = nft.owner_wallet_address;
    const listed_price = parseFloat(nft.price);

    
    if (parseFloat(paid_price) < listed_price) {
        await query('ROLLBACK');
        return res.status(400).json({ msg: `Paid price (${paid_price}) is less than listed price (${listed_price}).` });
    }
    
    
    let new_owner_user_id = null;
    const buyerUserWallet = await query('SELECT user_id FROM user_wallets WHERE wallet_address = $1', [buyer_wallet_address]);
    if (buyerUserWallet.rows.length > 0) {
        new_owner_user_id = buyerUserWallet.rows[0].user_id;
    }

    
    const updateNftResult = await query(
      'UPDATE nfts SET owner_wallet_address = $1, owner_user_id = $2, is_listed = FALSE, price = NULL, updated_at = CURRENT_TIMESTAMP WHERE mint_address = $3 RETURNING id',
      [buyer_wallet_address, new_owner_user_id, mintAddress]
    );

    if (updateNftResult.rowCount === 0) {
        await query('ROLLBACK');
        return res.status(500).json({ msg: 'Failed to update NFT ownership.'});
    }

    
    await query(
      'INSERT INTO transactions (nft_id, seller_wallet_address, buyer_wallet_address, price, transaction_signature) VALUES ($1, $2, $3, $4, $5)',
      [nft.id, seller_wallet_address, buyer_wallet_address, paid_price, transaction_signature]
    );

    await query('COMMIT');
    res.status(200).json({ msg: 'NFT purchase recorded successfully', nft_id: nft.id, buyer: buyer_wallet_address });

  } catch (err) {
    await query('ROLLBACK');
    console.error(`Error processing purchase for NFT ${mintAddress}:`, err.message);
    
    if (err.code === '23505') { 
        return res.status(409).json({ msg: 'This transaction signature has already been processed.' });
    }
    res.status(500).send('Server error during purchase processing.');
  }
});


router.post('/', authenticateToken, async (req, res) => {
  let { mint_address, price, owner_wallet_address, collection_name, image_url, metadata_url } = req.body;
  const listing_user_id = req.user.id;

  if (!mint_address || !price || !owner_wallet_address || !image_url || !metadata_url) {
    return res.status(400).json({ msg: 'Please provide mint_address, price, owner_wallet_address, image_url (S3), and metadata_url (S3)' });
  }

  try {
    const walletLinkCheck = await query('SELECT * FROM user_wallets WHERE user_id = $1 AND wallet_address = $2', [listing_user_id, owner_wallet_address]);
    if (walletLinkCheck.rows.length === 0) {
      return res.status(403).json({ msg: `Wallet ${owner_wallet_address} is not linked to your account or you do not own it.` });
    }

    const umi = getUmi();
    const isOwner = await verifyNFTOwner(umi, mint_address, owner_wallet_address);
    if (!isOwner) {
      return res.status(403).json({ msg: `Wallet ${owner_wallet_address} does not own the NFT with mint address ${mint_address}, or the NFT has a zero balance.` });
    }

    const solanaMetadata = await getNFTMetadata(mint_address);
    if (solanaMetadata && solanaMetadata.error) {
      console.warn(`Could not fetch live Solana metadata for ${mint_address} during listing: ${solanaMetadata.error}. Proceeding with provided data.`);
    }

    const nameToStore = solanaMetadata?.name || mint_address;
    const descriptionToStore = solanaMetadata?.description || '';
    const attributesToStore = solanaMetadata?.attributes ? JSON.stringify(solanaMetadata.attributes) : JSON.stringify([]);
    const symbolToStore = solanaMetadata?.symbol || '';

    const existingNft = await query('SELECT * FROM nfts WHERE mint_address = $1', [mint_address]);

    if (existingNft.rows.length > 0) {
      const updateQuery = `
        UPDATE nfts 
        SET 
          price = $1, 
          owner_wallet_address = $2, 
          owner_user_id = $3, 
          is_listed = TRUE, 
          name = $4, 
          image_url = $5,
          metadata_url = $6,
          description = $7,
          attributes = $8,
          collection_name = $9,
          symbol = $10,
          updated_at = CURRENT_TIMESTAMP
        WHERE mint_address = $11
        RETURNING *;`;
      const values = [
        price, owner_wallet_address, listing_user_id, nameToStore, 
        image_url,
        metadata_url,
        descriptionToStore, attributesToStore, collection_name, symbolToStore, mint_address
      ];
      const { rows } = await query(updateQuery, values);
      return res.status(200).json({ msg: 'NFT relisted successfully.', nft: rows[0] });
    } else {
      const insertQuery = `
        INSERT INTO nfts (mint_address, price, owner_wallet_address, owner_user_id, is_listed, name, image_url, metadata_url, description, attributes, collection_name, symbol, created_at, updated_at)
        VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *;`;
      const values = [
        mint_address, price, owner_wallet_address, listing_user_id, nameToStore, 
        image_url,
        metadata_url,
        descriptionToStore, attributesToStore, collection_name, symbolToStore
      ];
      const { rows } = await query(insertQuery, values);
      return res.status(201).json({ msg: 'NFT listed successfully.', nft: rows[0] });
    }
  } catch (err) {
    console.error('Error in POST /api/nfts:', err.message, err.stack);
    res.status(500).json({ msg: 'Server error while listing NFT.', error: err.message });
  }
});


router.post('/draft', authenticateToken, async (req, res) => {
  const creator_user_id = req.user.id; 

  if (!creator_user_id) {
    
    
    return res.status(403).json({ msg: 'User authentication failed or user ID not found in token.' });
  }

  const { 
    name, 
    symbol, 
    description, 
    image_url,        
    metadata_json_url, 
    price, 
    attributes, 
    collection_name 
  } = req.body;

  if (!name || !image_url || !metadata_json_url || price === undefined) {
    return res.status(400).json({ msg: 'Missing required fields: name, image_url, metadata_json_url, price' });
  }

  try {
    
    const { rows } = await query(
      'INSERT INTO draft_nfts (creator_user_id, name, symbol, description, image_url, metadata_json_url, price, attributes, collection_name, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [creator_user_id, name, symbol, description, image_url, metadata_json_url, price, attributes ? JSON.stringify(attributes) : null, collection_name, 'draft']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating draft NFT:', err.message);
    
    res.status(500).send('Server error: Failed to save draft NFT.');
  }
});



router.post('/finalize-mint/:draftId', authenticateToken, async (req, res) => {
  const { draftId } = req.params;
  const finalizing_user_id = req.user.id; 
  const { mint_address, owner_wallet_address } = req.body; 

  if (!mint_address || !owner_wallet_address) {
    return res.status(400).json({ msg: 'Mint address and owner wallet address are required.' });
  }

  await query('BEGIN'); 

  try {
    
    const draftResult = await query('SELECT * FROM draft_nfts WHERE id = $1', [draftId]);
    if (draftResult.rows.length === 0) {
      await query('ROLLBACK');
      return res.status(404).json({ msg: 'Draft NFT not found.' });
    }
    const draft = draftResult.rows[0];

    
    if (draft.creator_user_id !== finalizing_user_id) {
      await query('ROLLBACK');
      return res.status(403).json({ msg: 'Forbidden: You are not the creator of this draft.' });
    }

    
    const walletLinkCheck = await query('SELECT * FROM user_wallets WHERE user_id = $1 AND wallet_address = $2', [finalizing_user_id, owner_wallet_address]);
    if (walletLinkCheck.rows.length === 0) {
        await query('ROLLBACK');
        return res.status(403).json({ msg: `Wallet ${owner_wallet_address} is not linked to your account. Please link it before finalizing.` });
    }
    
    
    const umi = getUmi();
    const isOwner = await verifyNFTOwner(umi, mint_address, owner_wallet_address);
    if (!isOwner) {
      await query('ROLLBACK');
      return res.status(403).json({ msg: `On-chain verification failed: Wallet ${owner_wallet_address} does not own the NFT with mint address ${mint_address}, or the NFT has a zero balance.` });
    }

    
    const { rows } = await query(
      'INSERT INTO nfts (mint_address, name, symbol, image_url, metadata_url, description, price, owner_wallet_address, owner_user_id, attributes, collection_name, is_listed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE) RETURNING *',
      [mint_address, draft.name, draft.symbol, draft.image_url, draft.metadata_json_url, draft.description, draft.price, owner_wallet_address, finalizing_user_id, JSON.stringify(draft.attributes), draft.collection_name]
    );
    res.status(201).json(rows[0]);

    
    await query('UPDATE draft_nfts SET status = $1 WHERE id = $2', ['finalized', draftId]);

    await query('COMMIT');
    res.status(200).json({ msg: 'NFT finalized and listed successfully', nft_id: rows[0].id });

  } catch (err) {
    await query('ROLLBACK');
    const draftIdForLog = req.params.draftId || 'unknown_draft_id';
    const mintAddressForLog = req.body.mint_address || 'unknown_mint_address';
    console.error(`Error finalizing mint for draft ID ${draftIdForLog}, mint address ${mintAddressForLog}:`, err.message, err.stack);
    res.status(500).json({ 
        msg: 'Server error during finalization. Please check server logs.', 
        error: err.message 
    });
  }
});


router.delete('/drafts/:draftId', authenticateToken, async (req, res) => {
  const { draftId } = req.params;
  const userId = req.user.id;

  if (!draftId) {
    return res.status(400).json({ msg: 'Draft ID is required.' });
  }

  try {
    await query('BEGIN');

    
    const draftResult = await query('SELECT * FROM draft_nfts WHERE id = $1', [draftId]);
    if (draftResult.rows.length === 0) {
      await query('ROLLBACK');
      return res.status(404).json({ msg: 'Draft NFT not found.' });
    }
    const draft = draftResult.rows[0];

    
    if (draft.creator_user_id !== userId) {
      await query('ROLLBACK');
      return res.status(403).json({ msg: 'Forbidden: You are not the creator of this draft.' });
    }

    
    const deleteResult = await query('DELETE FROM draft_nfts WHERE id = $1 RETURNING image_url, metadata_json_url', [draftId]);
    if (deleteResult.rowCount === 0) {
      
      await query('ROLLBACK');
      return res.status(404).json({ msg: 'Draft NFT not found for deletion, or already deleted.' });
    }
    
    const { image_url, metadata_json_url } = deleteResult.rows[0];

    
    
    
    const fs = require('fs').promises;
    const path = require('path');

    if (image_url) {
      try {
        
        
        const imagePath = path.join(process.cwd(), image_url); 
        await fs.unlink(imagePath);
        console.log(`Deleted draft image: ${imagePath}`);
      } catch (fileErr) {
        
        console.error(`Failed to delete draft image ${image_url}:`, fileErr.message);
        
      }
    }

    if (metadata_json_url) {
      try {
        
        const metadataPath = path.join(process.cwd(), metadata_json_url);
        await fs.unlink(metadataPath);
        console.log(`Deleted draft metadata JSON: ${metadataPath}`);
      } catch (fileErr) {
        console.error(`Failed to delete draft metadata JSON ${metadata_json_url}:`, fileErr.message);
      }
    }

    await query('COMMIT');
    res.status(200).json({ msg: 'Draft NFT deleted successfully.' });

  } catch (err) {
    await query('ROLLBACK');
    console.error(`Error deleting draft NFT ID ${draftId}:`, err.message, err.stack);
    res.status(500).json({ 
        msg: 'Server error during draft deletion. Please check server logs.', 
        error: err.message 
    });
  }
});

module.exports = router;