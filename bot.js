const { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js')
const fetch = require('node-fetch')
require('dotenv').config()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
})

const guildConfigs = new Map()
const verifiedWallets = new Map()
const verificationQueue = new Map()
const userRateLimits = new Map()
const pendingSetups = new Map()

const RATE_LIMIT_WINDOW = 5 * 60 * 1000
const VERIFICATION_TIMEOUT = 10 * 60 * 1000
const POOL_SCRAPE_INTERVAL = 30 * 60 * 1000
const BACKUP_INTERVAL = 4 * 60 * 60 * 1000
const CARDANO_SCAN_INTERVAL = 30 * 1000

const RARITY_THRESHOLDS = {
  mythical: 50,
  legendary: 36,
  epic: 21,
  rare: 11,
  uncommon: 4,
  common: 1
}

function checkRateLimit(userId) {
  const now = Date.now()
  const lastAttempt = userRateLimits.get(userId) || 0
  
  if (now - lastAttempt < RATE_LIMIT_WINDOW) {
    return false
  }
  
  userRateLimits.set(userId, now)
  return true
}

function generateVerificationAmount() {
  const min = 1.0100
  const max = 1.6999
  return Number((Math.random() * (max - min) + min).toFixed(4))
}

function getRarityRole(count, config) {
  if (count >= RARITY_THRESHOLDS.mythical && config.rarityRoles.mythical) return config.rarityRoles.mythical
  if (count >= RARITY_THRESHOLDS.legendary && config.rarityRoles.legendary) return config.rarityRoles.legendary
  if (count >= RARITY_THRESHOLDS.epic && config.rarityRoles.epic) return config.rarityRoles.epic
  if (count >= RARITY_THRESHOLDS.rare && config.rarityRoles.rare) return config.rarityRoles.rare
  if (count >= RARITY_THRESHOLDS.uncommon && config.rarityRoles.uncommon) return config.rarityRoles.uncommon
  if (count >= RARITY_THRESHOLDS.common && config.rarityRoles.common) return config.rarityRoles.common
  return null
}

async function scrapeCardanoScan(address) {
  try {
    console.log(`Scraping CardanoScan for address: ${address}`)
    const url = `https://cardanoscan.io/address/${address}`
    const response = await fetch(url)
    const html = await response.text()
    
    console.log(`CardanoScan response length: ${html.length}`)
    
    const selfTxPattern = new RegExp(`${address}.*?${address}.*?(\\d+\\.\\d{4})\\s*₳`, 'g')
    const matches = Array.from(html.matchAll(selfTxPattern))
    
    console.log(`Found ${matches.length} potential self-transactions`)
    
    for (const match of matches) {
      const amount = parseFloat(match[1])
      console.log(`Found transaction amount: ${amount}`)
      return amount
    }
    
    return null
  } catch (error) {
    console.error('CardanoScan scrape error:', error)
    return null
  }
}

async function scrapePoolPm(address) {
  try {
    console.log(`Scraping Pool.pm for address: ${address}`)
    const url = `https://pool.pm/${address}`
    const response = await fetch(url)
    const html = await response.text()
    
    console.log(`Pool.pm response length: ${html.length}`)
    
    const assets = new Map()
    const policyPattern = /"policy":"([a-f0-9]+)"/g
    let match
    
    while ((match = policyPattern.exec(html)) !== null) {
      const policyId = match[1]
      assets.set(policyId, (assets.get(policyId) || 0) + 1)
    }
    
    console.log(`Found ${assets.size} unique policy IDs`)
    for (const [policy, count] of assets) {
      console.log(`Policy ${policy}: ${count} assets`)
    }
    
    return assets
  } catch (error) {
    console.error('Pool.pm scrape error:', error)
    return new Map()
  }
}

async function processVerifications() {
  const now = Date.now()
  
  for (const [userId, verification] of verificationQueue) {
    if (now - verification.timestamp > VERIFICATION_TIMEOUT) {
      console.log(`Verification timeout for user ${userId}`)
      verificationQueue.delete(userId)
      continue
    }
    
    try {
      console.log(`Checking verification for user ${userId}, looking for amount ${verification.amount}`)
      const detectedAmount = await scrapeCardanoScan(verification.address)
      console.log(`Detected amount: ${detectedAmount}`)
      
      if (detectedAmount === verification.amount) {
        console.log(`Verification successful for user ${userId}`)
        verificationQueue.delete(userId)
        
        const userData = {
          address: verification.address,
          assignedRoles: new Set(),
          lastChecked: now
        }
        
        verifiedWallets.set(userId, userData)
        await updateUserRoles(userId, verification.guildId)
        
        console.log(`Verification complete for user ${userId}`)
      }
    } catch (error) {
      console.error(`Verification error for ${userId}:`, error)
    }
  }
}

async function updateUserRoles(userId, guildId) {
  try {
    console.log(`Updating roles for user ${userId} in guild ${guildId}`)
    const guild = await client.guilds.fetch(guildId)
    const member = await guild.members.fetch(userId)
    const userData = verifiedWallets.get(userId)
    
    if (!userData) {
      console.log(`No user data found for ${userId}`)
      return
    }
    
    const assets = await scrapePoolPm(userData.address)
    console.log(`Found ${assets.size} asset types for address ${userData.address}`)
    
    const configs = guildConfigs.get(guildId) || []
    console.log(`Processing ${configs.length} configurations`)
    
    for (const config of configs) {
      if (config.assetType !== 'nft') continue
      
      console.log(`Checking policy ${config.policyId}`)
      const assetCount = assets.get(config.policyId) || 0
      console.log(`User has ${assetCount} assets for this policy`)
      
      const hasAssets = assetCount > 0
      const currentRarityRole = getRarityRole(assetCount, config)
      
      console.log(`Should assign base role: ${hasAssets}`)
      console.log(`Rarity role to assign: ${currentRarityRole}`)
      
      try {
        if (hasAssets) {
          if (!member.roles.cache.has(config.baseRole)) {
            console.log(`Adding base role ${config.baseRole}`)
            await member.roles.add(config.baseRole)
            userData.assignedRoles.add(config.baseRole)
          }
          
          for (const [tier, roleId] of Object.entries(config.rarityRoles)) {
            if (roleId && member.roles.cache.has(roleId) && roleId !== currentRarityRole) {
              console.log(`Removing old rarity role ${roleId}`)
              await member.roles.remove(roleId)
              userData.assignedRoles.delete(roleId)
            }
          }
          
          if (currentRarityRole && !member.roles.cache.has(currentRarityRole)) {
            console.log(`Adding rarity role ${currentRarityRole}`)
            await member.roles.add(currentRarityRole)
            userData.assignedRoles.add(currentRarityRole)
          }
        } else {
          if (member.roles.cache.has(config.baseRole)) {
            console.log(`Removing base role ${config.baseRole}`)
            await member.roles.remove(config.baseRole)
            userData.assignedRoles.delete(config.baseRole)
          }
          
          for (const [tier, roleId] of Object.entries(config.rarityRoles)) {
            if (roleId && member.roles.cache.has(roleId)) {
              console.log(`Removing rarity role ${roleId}`)
              await member.roles.remove(roleId)
              userData.assignedRoles.delete(roleId)
            }
          }
        }
      } catch (roleError) {
        console.error(`Role management error for ${userId}:`, roleError)
      }
    }
    
    userData.lastChecked = Date.now()
    console.log(`Role update complete for user ${userId}`)
  } catch (error) {
    console.error(`Update roles error for ${userId}:`, error)
  }
}

async function processAllUsers() {
  try {
    console.log(`Processing ${verifiedWallets.size} verified users`)
    for (const [userId, userData] of verifiedWallets) {
      for (const [guildId, configs] of guildConfigs) {
        await updateUserRoles(userId, guildId)
      }
    }
  } catch (error) {
    console.error('Process all users error:', error)
  }
}

async function dumpBackups() {
  try {
    for (const [guildId, configs] of guildConfigs) {
      const backupChannels = [...new Set(configs.map(c => c.backupChannelId).filter(Boolean))]
      
      for (const channelId of backupChannels) {
        try {
          const channel = await client.channels.fetch(channelId)
          if (!channel) continue
          
          const backupData = new Map()
          
          for (const [userId, userData] of verifiedWallets) {
            if (userData.assignedRoles.size > 0) {
              const roleNames = []
              for (const roleId of userData.assignedRoles) {
                try {
                  const guild = await client.guilds.fetch(guildId)
                  const role = await guild.roles.fetch(roleId)
                  if (role) roleNames.push(role.name)
                } catch (roleError) {
                  console.error('Role fetch error:', roleError)
                }
              }
              if (roleNames.length > 0) {
                backupData.set(userId, roleNames.join(', '))
              }
            }
          }
          
          if (backupData.size === 0) {
            await channel.send('📋 **Wallet Verification Backup** - No verified users with roles.')
            continue
          }
          
          let backupReport = '📋 **Wallet Verification Backup**\n'
          for (const [userId, roles] of backupData) {
            backupReport += `<@${userId}>: ${roles}\n`
          }
          
          await channel.send(backupReport)
        } catch (channelError) {
          console.error('Backup channel error:', channelError)
        }
      }
    }
  } catch (error) {
    console.error('Backup dump error:', error)
  }
}

const setupCommand = new SlashCommandBuilder()
  .setName('setupverify')
  .setDescription('Setup wallet verification for policy ID')
  .addStringOption(option =>
    option.setName('policy_id')
      .setDescription('Cardano policy ID to track')
      .setRequired(true))
  .addRoleOption(option =>
    option.setName('base_role')
      .setDescription('Role for holding any NFT from this policy')
      .setRequired(true))
  .addChannelOption(option =>
    option.setName('backup_channel')
      .setDescription('Channel for backup data')
      .setRequired(true))

const verifyCommand = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Verify wallet ownership')
  .addStringOption(option =>
    option.setName('wallet_address')
      .setDescription('Your Cardano wallet address (addr1...)')
      .setRequired(true))

const restoreCommand = new SlashCommandBuilder()
  .setName('restoreverify')
  .setDescription('Restore verification data from backup channel (Admin only)')
  .addChannelOption(option =>
    option.setName('backup_channel')
      .setDescription('Channel containing backup data')
      .setRequired(true))

client.once('ready', async () => {
  try {
    console.log(`Logged in as ${client.user.tag}`)
    await client.application.commands.set([setupCommand, verifyCommand, restoreCommand])
    console.log('Slash commands registered')
    
    client.user.setPresence({
      activities: [{ name: 'wallet verifications', type: 'WATCHING' }],
      status: 'online'
    })
    
    setInterval(processVerifications, CARDANO_SCAN_INTERVAL)
    setInterval(processAllUsers, POOL_SCRAPE_INTERVAL)
    setInterval(dumpBackups, BACKUP_INTERVAL)
    
  } catch (error) {
    console.error('Ready event error:', error)
  }
})

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isCommand()) {
      
      if (interaction.commandName === 'setupverify') {
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.reply({
            content: '❌ Only administrators can use this command.',
            flags: 64
          })
          return
        }
        
        const policyId = interaction.options.getString('policy_id')
        const baseRole = interaction.options.getRole('base_role')
        const backupChannel = interaction.options.getChannel('backup_channel')
        
        if (!policyId.match(/^[a-f0-9]{56}$/)) {
          await interaction.reply({
            content: '❌ Invalid policy ID format. Must be 56 character hex string.',
            flags: 64
          })
          return
        }
        
        const setupId = `setup_${Date.now()}`
        
        pendingSetups.set(setupId, {
          policyId,
          baseRole: baseRole.id,
          baseRoleName: baseRole.name,
          backupChannelId: backupChannel.id,
          guildId: interaction.guildId,
          timestamp: Date.now()
        })
        
        console.log(`Setup initiated for policy ${policyId} with base role ${baseRole.name}`)
        
        const assetTypeMenu = new StringSelectMenuBuilder()
          .setCustomId(`asset_type_${setupId}`)
          .setPlaceholder('Select asset type')
          .addOptions([
            {
              label: 'NFT',
              value: 'nft',
              description: 'Non-fungible tokens tracked via pool.pm'
            },
            {
              label: 'Token',
              value: 'token', 
              description: 'Fungible tokens tracked via CardanoScan'
            }
          ])
        
        const row = new ActionRowBuilder().addComponents(assetTypeMenu)
        
        await interaction.reply({
          content: 'Select the asset type to track:',
          components: [row],
          flags: 64
        })
      }
      
      if (interaction.commandName === 'verify') {
        const walletAddress = interaction.options.getString('wallet_address')
        
        if (!walletAddress.startsWith('addr1')) {
          await interaction.reply({
            content: '❌ Invalid Cardano address. Must start with "addr1".',
            flags: 64
          })
          return
        }
        
        if (!checkRateLimit(interaction.user.id)) {
          await interaction.reply({
            content: '⏰ Rate limit exceeded. Please wait 5 minutes before trying again.',
            flags: 64
          })
          return
        }
        
        const configs = guildConfigs.get(interaction.guildId)
        if (!configs || configs.length === 0) {
          await interaction.reply({
            content: '❌ No verification configured. Ask an admin to run /setupverify first.',
            flags: 64
          })
          return
        }
        
        const verificationAmount = generateVerificationAmount()
        
        verificationQueue.set(interaction.user.id, {
          address: walletAddress,
          amount: verificationAmount,
          timestamp: Date.now(),
          guildId: interaction.guildId
        })
        
        console.log(`Verification started for user ${interaction.user.id}, address ${walletAddress}, amount ${verificationAmount}`)
        
        await interaction.reply({
          content: `🔐 **Wallet Verification**\n\nSend exactly **${verificationAmount} ADA** from your wallet to itself (same address).\n\n**Your Address:** ${walletAddress}\n**Amount:** ${verificationAmount} ADA\n\nI'll monitor for this transaction for 10 minutes.`,
          flags: 64
        })
      }
      
      if (interaction.commandName === 'restoreverify') {
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.reply({
            content: '❌ Only administrators can use this command.',
            flags: 64
          })
          return
        }
        
        const backupChannel = interaction.options.getChannel('backup_channel')
        
        try {
          const channel = await client.channels.fetch(backupChannel.id)
          const messages = await channel.messages.fetch({ limit: 50 })
          const backupMessage = messages.find(msg => 
            msg.content.includes('📋') && msg.content.includes('Wallet Verification Backup')
          )
          
          if (!backupMessage) {
            await interaction.reply({
              content: '❌ No backup data found in selected channel.',
              flags: 64
            })
            return
          }
          
          let restoredCount = 0
          const userMatches = backupMessage.content.matchAll(/<@(\d+)>:\s*([^\\n]+)/g)
          
          for (const match of userMatches) {
            const userId = match[1]
            const roleNames = match[2].split(',').map(r => r.trim())
            
            verifiedWallets.set(userId, {
              address: 'restored',
              assignedRoles: new Set(),
              lastChecked: Date.now()
            })
            
            restoredCount++
          }
          
          await interaction.reply({
            content: `✅ Restored verification data for ${restoredCount} users from backup.`,
            flags: 64
          })
          
        } catch (error) {
          console.error('Restore error:', error)
          await interaction.reply({
            content: '❌ Error restoring data. Check logs.',
            flags: 64
          })
        }
      }
    }
    
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('asset_type_')) {
        const setupId = interaction.customId.replace('asset_type_', '')
        const pendingSetup = pendingSetups.get(setupId)
        
        if (!pendingSetup) {
          await interaction.reply({
            content: '❌ Setup session expired. Please run /setupverify again.',
            flags: 64
          })
          return
        }
        
        const assetType = interaction.values[0]
        
        if (assetType === 'token') {
          await interaction.reply({
            content: '🚧 **Token tracking coming soon!**\n\nPlease use NFT option for now.',
            flags: 64
          })
          return
        }
        
        const rarityMenus = []
        const rarityOptions = ['mythical', 'legendary', 'epic', 'rare', 'uncommon', 'common']
        
        for (let i = 0; i < rarityOptions.length && i < 5; i++) {
          const rarity = rarityOptions[i]
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`rarity_${rarity}_${setupId}`)
            .setPlaceholder(`Select ${rarity} role (optional)`)
            .addOptions([
              {
                label: 'Skip this tier',
                value: 'skip',
                description: `Don't assign a role for ${rarity} tier`
              }
            ])
          
          try {
            const guild = await client.guilds.fetch(interaction.guildId)
            const roles = await guild.roles.fetch()
            
            let optionCount = 1
            for (const [roleId, role] of roles) {
              if (role.name !== '@everyone' && optionCount < 25) {
                menu.addOptions({
                  label: role.name,
                  value: roleId,
                  description: `Assign ${role.name} for ${rarity} tier`
                })
                optionCount++
              }
            }
          } catch (error) {
            console.error('Role fetch error:', error)
          }
          
          rarityMenus.push(new ActionRowBuilder().addComponents(menu))
        }
        
        await interaction.reply({
          content: `🎯 **NFT Rarity Setup for Policy ID:** ${pendingSetup.policyId}\n\nSelect roles for each rarity tier (you can skip tiers you don't need):\n\n**50+ NFTs** = Mythical\n**36-49 NFTs** = Legendary\n**21-35 NFTs** = Epic\n**11-20 NFTs** = Rare\n**4-10 NFTs** = Uncommon\n**1-3 NFTs** = Common`,
          components: rarityMenus,
          flags: 64
        })
        
        if (!guildConfigs.has(interaction.guildId)) {
          guildConfigs.set(interaction.guildId, [])
        }
        
        const config = {
          policyId: pendingSetup.policyId,
          baseRole: pendingSetup.baseRole,
          backupChannelId: pendingSetup.backupChannelId,
          assetType: 'nft',
          rarityRoles: {},
          setupId: setupId
        }
        
        guildConfigs.get(interaction.guildId).push(config)
        console.log(`Added config for policy ${pendingSetup.policyId} to guild ${interaction.guildId}`)
      }
      
      if (interaction.customId.startsWith('rarity_')) {
        const parts = interaction.customId.split('_')
        const rarity = parts[1]
        const setupId = parts[2]
        const selectedValue = interaction.values[0]
        
        const configs = guildConfigs.get(interaction.guildId)
        const config = configs?.find(c => c.setupId === setupId)
        
        if (config) {
          config.rarityRoles[rarity] = selectedValue === 'skip' ? null : selectedValue
          console.log(`Set ${rarity} role to ${selectedValue === 'skip' ? 'skip' : selectedValue} for policy ${config.policyId}`)
        }
        
        await interaction.reply({
          content: `✅ ${rarity} tier ${selectedValue === 'skip' ? 'skipped' : 'configured'}`,
          flags: 64
        })
      }
    }
    
  } catch (error) {
    console.error('Interaction error:', error)
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'An error occurred while processing your request.',
        flags: 64
      })
    }
  }
})

const TOKEN = process.env.DISCORD_TOKEN
try {
  client.login(TOKEN)
} catch (error) {
  console.error('Login error:', error)
}