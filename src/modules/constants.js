// Chain configuration
export const POLYGON_CHAIN_ID = 137;

// Contract addresses (Polygon Mainnet)
// NOTE: `USDC_ADDRESS` is retained for backward compatibility in the codebase,
// but on V2 it is the pUSD collateral token address.
export const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
export const USDC_ADDRESS = PUSD_ADDRESS;
export const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const CTF_EXCHANGE_ADDRESS = '0xE111180000d2663C0091e4f400237545B87B996B';
export const NEG_RISK_CTF_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59';
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
export const NEG_RISK_WRAPPED_COLLATERAL_ADDRESS = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2';
export const COLLATERAL_ONRAMP_ADDRESS = '0x93070a847efEf7F70739046A929D47a521F5B8ee';

// API endpoints
export const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
export const CLOB_API_URL = 'https://clob.polymarket.com';
export const DATA_API_URL = 'https://data-api.polymarket.com';

// ABIs (minimal)
export const CTF_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint indexSet) external view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) external view returns (uint256)',
  'function balanceOf(address account, uint256 id) external view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) external view returns (uint256[])',
  
  // ERC1155 approval methods (CTF contract implements ERC1155)
  // CRITICAL: Conditional tokens (YES/NO) are ERC1155 token IDs, NOT separate ERC20 contracts
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address owner, address operator) external view returns (bool)'
];

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function transfer(address to, uint256 amount) external returns (bool)'
];

export const COLLATERAL_ONRAMP_ABI = [
  'function wrap(address _asset, address _to, uint256 _amount) external',
  'function COLLATERAL_TOKEN() external view returns (address)'
];

// Constants
export const USDC_DECIMALS = 6; // CRITICAL: NOT 18!
export const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const BINARY_PARTITION = [1, 2]; // YES=1, NO=2
