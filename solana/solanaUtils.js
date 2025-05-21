const { Connection, PublicKey } = require('@solana/web3.js');
const { publicKey, some } = require('@metaplex-foundation/umi');
const { createUmi: createUmiFromBundle } = require('@metaplex-foundation/umi-bundle-defaults');

const { mplTokenMetadata, fetchDigitalAsset, fetchDigitalAssetWithTokenByMint } = require('@metaplex-foundation/mpl-token-metadata');
const { mplToolbox } = require('@metaplex-foundation/mpl-toolbox');
const bs58 = require('bs58');

require('dotenv').config({ path: '../.env' });

let umiInstance;
const getUmi = () => {
  if (!umiInstance) {
    const rpcUrlFromEnv = process.env.SOLANA_RPC_URL;
    if (!rpcUrlFromEnv) {
      console.error('SOLANA_RPC_URL is not defined in the .env file or is empty');
      throw new Error('SOLANA_RPC_URL is not defined or is empty');
    }
    const rpcUrl = rpcUrlFromEnv.trim();
    console.log('[DEBUG] Trimmed SOLANA_RPC_URL in getUmi:', JSON.stringify(rpcUrl));

    try {
      new URL(rpcUrl);
      console.log('[DEBUG] new URL(rpcUrl) construction was successful.');
    } catch (e) {
      console.error('[DEBUG] new URL(rpcUrl) FAILED directly:', e.message);
      throw e; 
    }

    
    umiInstance = createUmiFromBundle(rpcUrl)
      .use(mplTokenMetadata())
      .use(mplToolbox());

    console.log(`Umi instance configured using createUmiFromBundle (endpoint: ${rpcUrl}), mplTokenMetadata, and mplToolbox`);
  }
  return umiInstance;
};



const getNFTMetadata = async (mintAddressBase58) => {
  try {
    const umi = getUmi();
    const mint = publicKey(mintAddressBase58);

    console.log(`Fetching digital asset for mint: ${mintAddressBase58} using Umi`);
    const asset = await fetchDigitalAsset(umi, mint);

    if (!asset) {
      console.log(`No digital asset found for mint ${mintAddressBase58}`);
      return null;
    }

    
    

    
    
    if (!asset.metadata?.json) {
        console.warn(`[getNFTMetadata] Off-chain JSON metadata not loaded for ${mintAddressBase58}. URI: ${asset.metadata.uri}`);
        
        
        
        
    } else {
        
        console.log(`[getNFTMetadata] asset.metadata.uri for ${mintAddressBase58}:`, asset.metadata.uri);
        console.log(`[getNFTMetadata] asset.metadata.json for ${mintAddressBase58} (attributes part):`, JSON.stringify(asset.metadata.json?.attributes, null, 2));
        console.log(`[getNFTMetadata] asset.metadata.json for ${mintAddressBase58} (full json object if small, or just keys):`, Object.keys(asset.metadata.json).length < 10 ? JSON.stringify(asset.metadata.json, null, 2) : Object.keys(asset.metadata.json).join(', '));
    }

    const metadata = {
      mintAddress: asset.publicKey?.toString() ?? mintAddressBase58,
      name: asset.metadata.name,
      symbol: asset.metadata.symbol,
      uri: asset.metadata.uri,
      isMutable: asset.metadata.isMutable,
      primarySaleHappened: asset.metadata.primarySaleHappened,
      sellerFeeBasisPoints: asset.metadata.sellerFeeBasisPoints?.basisPoints?.toString() ?? '0',
      creators: Array.isArray(asset.metadata.creators) 
                ? asset.metadata.creators.map(creator => ({
                    address: creator.address?.toString(),
                    verified: creator.verified,
                    share: creator.share,
                  })) 
                : [], 
      tokenStandard: asset.metadata.tokenStandard?.toString() ?? 'Unknown',
      collection: asset.metadata.collection ? {
        key: asset.metadata.collection.key?.toString(),
        verified: asset.metadata.collection.verified,
      } : null,
      
      json: asset.metadata.json, 
      
      image: asset.metadata.json?.image || null,
      description: asset.metadata.json?.description || null,
      attributes: asset.metadata.json?.attributes || [],
    };

    console.log(`Successfully fetched metadata for ${mintAddressBase58}`);
    return metadata;

  } catch (error) {
    console.error(`Error fetching metadata for mint ${mintAddressBase58} with Umi:`, error);
    if (error.message && error.message.includes('AccountNotFoundError')) {
        return { error: `NFT data not found on-chain for mint: ${mintAddressBase58}. It might not be a valid Metaplex NFT.`, status: 404 };
    }
    if (error.message && error.message.toLowerCase().includes('invalid public key')) {
        return { error: `Invalid mint address format: ${mintAddressBase58}`, status: 400 };
    }
    
    if (error instanceof TypeError && error.message.includes('Failed to fetch')){
        console.error(`Failed to fetch off-chain JSON metadata from URI for ${mintAddressBase58}`);
        return { error: `Failed to fetch off-chain JSON metadata for ${mintAddressBase58}. URI may be invalid or inaccessible.`, status: 502 };
    }
    return { error: `An unexpected error occurred while fetching NFT metadata: ${error.message}`, status: 500 };
  }
};




let legacyConnection;
const getSolanaConnection = () => {
  if (!legacyConnection) {
    if (!process.env.SOLANA_RPC_URL) {
      console.error('SOLANA_RPC_URL is not defined in the .env file (for legacy connection)');
      throw new Error('SOLANA_RPC_URL is not defined for legacy connection');
    }
    legacyConnection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
    console.log(`Legacy Solana Connection to RPC: ${process.env.SOLANA_RPC_URL}`);
  }
  return legacyConnection;
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));


const verifyNFTOwner = async (clientUmi, mintAddressBase58, expectedOwnerAddressBase58) => {
  console.log(`Verifying ownership for mint ${mintAddressBase58} by owner ${expectedOwnerAddressBase58}`);
  const legacyConnection = getSolanaConnection();
  const maxRetries = 3; 
  const retryDelayMs = 1000;

  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Attempt ${attempt}/${maxRetries}] Checking token accounts for owner ${expectedOwnerAddressBase58} via getParsedTokenAccountsByOwner...`);
      const parsedTokenAccountsForOwner = await legacyConnection.getParsedTokenAccountsByOwner(
        new PublicKey(expectedOwnerAddressBase58), 
        {
          programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          commitment: 'confirmed',
        }
      );

      console.log(`[Attempt ${attempt}] Found ${parsedTokenAccountsForOwner.value.length} token accounts for owner ${expectedOwnerAddressBase58} via getParsedTokenAccountsByOwner.`);
      if (parsedTokenAccountsForOwner.value.length > 0) {
        console.log(`[Attempt ${attempt}] Details of token accounts found for owner (getParsedTokenAccountsByOwner):`);
        parsedTokenAccountsForOwner.value.forEach((acc, index) => {
          try {
            const info = acc.account.data.parsed.info;
            console.log(
              `  Account ${index + 1}: Mint: ${info.mint}, Amount: ${info.tokenAmount?.uiAmountString || info.tokenAmount?.amount || 'N/A'}, Owner: ${info.owner}`
            );
          } catch (e) {
            console.log(`  Account ${index + 1}: Error parsing account info - ${e.message}`);
          }
        });
      }

      const ownerAccount = parsedTokenAccountsForOwner.value.find(acc => 
        acc.account.data.parsed.info.mint === mintAddressBase58 &&
        acc.account.data.parsed.info.tokenAmount.uiAmount > 0
      );

      if (ownerAccount) {
        console.log(`[Attempt ${attempt}] Ownership confirmed via getParsedTokenAccountsByOwner for mint ${mintAddressBase58} by ${expectedOwnerAddressBase58}.`);
        return true;
      }
      
      console.log(`[Attempt ${attempt}] No matching token account found via getParsedTokenAccountsByOwner for mint ${mintAddressBase58} owned by ${expectedOwnerAddressBase58}.`);
      if (attempt < maxRetries) await delay(retryDelayMs);

    } catch (error) {
      console.error(`[Attempt ${attempt}] Error during getParsedTokenAccountsByOwner for mint ${mintAddressBase58}:`, error);
      if (attempt < maxRetries) await delay(retryDelayMs);
    }
  }
  console.log('Failed to verify ownership via getParsedTokenAccountsByOwner after retries. Proceeding to direct ATA check.');

  
  try {
    console.log(`[Direct Check] Attempting to find and verify ATA for mint ${mintAddressBase58} and owner ${expectedOwnerAddressBase58}`);
    const { findAssociatedTokenPda } = require('@metaplex-foundation/mpl-toolbox'); 
    const mintPublicKeyForUmi = publicKey(mintAddressBase58);
    const ownerPublicKeyForUmi = publicKey(expectedOwnerAddressBase58);
    
    const ata = findAssociatedTokenPda(clientUmi, {
      mint: mintPublicKeyForUmi,
      owner: ownerPublicKeyForUmi,
    });
    
    const ataAddressString = ata[0].toString();
    console.log(`[Direct Check] Derived ATA address: ${ataAddressString}`);

    const tokenAccountInfo = await clientUmi.rpc.getAccount(ata[0]); 

    if (!tokenAccountInfo.exists) {
      console.log(`[Direct Check] ATA ${ataAddressString} does not exist on-chain.`);
      return false;
    }
    console.log(`[Direct Check] ATA ${ataAddressString} exists. Fetching and parsing data...`);

    
    
    
    const ataWeb3Pk = new PublicKey(ataAddressString); 
    const directAtaInfo = await legacyConnection.getParsedAccountInfo(ataWeb3Pk, 'confirmed');

    if (!directAtaInfo || !directAtaInfo.value) {
        console.log(`[Direct Check] Could not fetch parsed account info for ATA ${ataAddressString} via web3.js.`);
        return false;
    }
    
    const accountData = directAtaInfo.value.data;
    if (accountData && accountData.program === 'spl-token' && accountData.parsed) {
        const info = accountData.parsed.info;
        console.log(`[Direct Check] Parsed ATA info: Mint: ${info.mint}, Owner: ${info.owner}, Amount: ${info.tokenAmount?.uiAmountString || info.tokenAmount?.amount}`);
        if (info.mint === mintAddressBase58 && 
            info.owner === expectedOwnerAddressBase8 &&
            parseFloat(info.tokenAmount?.uiAmountString || info.tokenAmount?.amount || '0') > 0) {
            console.log(`[Direct Check] Ownership CONFIRMED for mint ${mintAddressBase58} via direct ATA check.`);
            return true;
        } else {
            console.log(`[Direct Check] Ownership MISMATCH or ZERO BALANCE for ATA ${ataAddressString}. Details: Mint: ${info.mint}, Owner: ${info.owner}, Amount: ${info.tokenAmount?.uiAmountString || info.tokenAmount?.amount}`);
        }
    } else {
        console.log(`[Direct Check] Account ${ataAddressString} is not a recognized SPL token account or has no parsed data.`);
    }

  } catch (error) {
    console.error(`[Direct Check] Error during direct ATA check for mint ${mintAddressBase58}:`, error);
  }

  console.log(`[Final] Ownership verification ultimately FAILED for mint ${mintAddressBase58} by ${expectedOwnerAddressBase8}.`);
  return false;
};

module.exports = {
  getUmi,
  getNFTMetadata,
  verifyNFTOwner,
  getSolanaConnection,
};