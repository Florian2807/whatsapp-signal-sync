const axios = require('axios')

module.exports = function createSignalClient ({ baseUrl, number }) {
  if (!baseUrl) throw new Error('SIGNAL_API_URL not set')
  const api = axios.create({ baseURL: baseUrl, timeout: 30000 })

  return {
    baseUrl,
    number,

    // send text to individual recipient (signal number in international format)
    sendText: async (to, text) => {
      const payload = { 
        message: text, 
        recipients: [to],
        text_mode: "normal"
      }
      const res = await api.post('/v2/send', payload)
      return res.data
    },

    // send text to group
    sendGroupText: async (groupId, text) => {
      try {
        // Validate groupId format
        if (!groupId || typeof groupId !== 'string') {
          throw new Error(`Invalid groupId: ${groupId}`)
        }
        
        const payload = { 
          message: text, 
          number,
          recipients: [groupId],  // v2 API uses recipients array instead of groupId
          text_mode: "normal"
        }
        console.log(`📤 Sending to Signal group ${groupId}:`, text.substring(0, 100) + (text.length > 100 ? '...' : ''))
        console.log(`📋 Payload:`, JSON.stringify(payload, null, 2))
        const res = await api.post('/v2/send', payload)
        console.log(`✅ Signal message sent successfully`)
        return res.data
      } catch (error) {
        console.error(`❌ Error sending to Signal group ${groupId}:`)
        console.error(`   Status: ${error.response?.status}`)
        console.error(`   StatusText: ${error.response?.statusText}`) 
        console.error(`   Data:`, error.response?.data)
        console.error(`   Message: ${error.message}`)
        console.error(`   Payload was:`, JSON.stringify({ message: text, recipients: [groupId] }, null, 2))
        
        if (error.response?.data?.error?.includes('valid number')) {
          console.error(`\n💡 TIPP: Die Signal Group ID "${groupId}" scheint ungültig zu sein.`)
          console.error(`   Signal Group IDs sollten Base64-kodierte Strings sein`)
          console.error(`   Überprüfen Sie Ihre group-mappings.json Datei.`)
        }
        
        throw error
      }
    },

    // send attachment to individual recipient
    sendAttachment: async (to, buffer, filename, mimetype) => {
      try {
        // Convert buffer to base64 for v2 API format
        const base64Data = buffer.toString('base64')
        const base64Attachment = filename ? 
          `data:${mimetype || 'application/octet-stream'};filename=${filename};base64,${base64Data}` :
          `data:${mimetype || 'application/octet-stream'};base64,${base64Data}`
        
        const payload = {
          message: filename || 'file',
          recipients: [to],
          base64_attachments: [base64Attachment],
          text_mode: "normal"
        }
        
        console.log(`📎 Sending attachment to ${to}:`, filename, `(${mimetype})`)
        const res = await api.post('/v2/send', payload)
        console.log(`✅ Signal attachment sent successfully`)
        return res.data
      } catch (error) {
        console.error(`❌ Error sending attachment to ${to}:`, error.message)
        throw error
      }
    },

    // send attachment to group
    sendGroupAttachment: async (groupId, buffer, filename, mimetype) => {
      try {
        // Validate groupId format
        if (!groupId || typeof groupId !== 'string') {
          throw new Error(`Invalid groupId: ${groupId}`)
        }
        
        // Check if groupId looks like a valid Signal group ID
        if (!groupId.match(/^[A-Za-z0-9+/=]+$/) && !groupId.startsWith('+')) {
          console.warn(`⚠️ Group ID "${groupId}" doesn't look like a valid Signal group ID`)
        }
        
        // Convert buffer to base64 for v2 API format
        const base64Data = buffer.toString('base64')
        const base64Attachment = filename ? 
          `data:${mimetype || 'application/octet-stream'};filename=${filename};base64,${base64Data}` :
          `data:${mimetype || 'application/octet-stream'};base64,${base64Data}`
        
        const payload = {
          message: filename || 'file',
          recipients: [groupId],
          base64_attachments: [base64Attachment],
          text_mode: "normal"
        }

        console.log(`📎 Sending attachment to Signal group ${groupId}:`, filename, `(${mimetype})`)
        const res = await api.post('/v2/send', payload)
        console.log(`✅ Signal attachment sent successfully`)
        return res.data
      } catch (error) {
        console.error(`❌ Error sending attachment to Signal group ${groupId}:`)
        console.error(`   Status: ${error.response?.status}`)
        console.error(`   StatusText: ${error.response?.statusText}`) 
        console.error(`   Data:`, error.response?.data)
        console.error(`   Message: ${error.message}`)
        console.error(`   Attachment: ${filename} (${mimetype})`)
        
        if (error.response?.data?.error?.includes('valid number')) {
          console.error(`\n💡 TIPP: Die Signal Group ID "${groupId}" scheint ungültig zu sein.`)
          console.error(`   Überprüfen Sie Ihre group-mappings.json Datei.`)
        }
        
        throw error
      }
    },

    // get available groups
    getGroups: async () => {
      try {
        const res = await api.get(`/v1/groups/${encodeURIComponent(number)}`)
        return res.data
      } catch (err) {
        console.error('Error fetching Signal groups:', err.message)
        return []
      }
    },

    // create a new group
    createGroup: async (name, members = []) => {
      const payload = { name, members }
      const res = await api.post(`/v1/groups/${encodeURIComponent(number)}`, payload)
      return res.data
    }
  }
}
