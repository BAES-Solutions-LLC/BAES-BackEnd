import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: Missing Supabase environment variables');
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) in your .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Twilio client (for SMS)
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

let twilioClient = null;
if (twilioAccountSid && twilioAuthToken) {
  twilioClient = twilio(twilioAccountSid, twilioAuthToken);
  console.log('Twilio client initialized for SMS');
} else {
  console.warn('Warning: Twilio credentials not found. SMS OTP features will not work.');
}

// Initialize SendGrid (for Email) - SendGrid is separate from Twilio
const sendGridApiKey = process.env.SENDGRID_API_KEY;
const sendGridFromEmail = process.env.SENDGRID_FROM_EMAIL || process.env.TWILIO_FROM_EMAIL || 'noreply@baessolutions.com';

if (!sendGridApiKey) {
  console.warn('Warning: SendGrid API key not found. Email OTP features will not work.');
} else {
  console.log('SendGrid configured for email');
}

// OTP Configuration
const OTP_EXPIRY_MINUTES = 10; // OTP expires in 10 minutes
const MAX_OTP_ATTEMPTS = 5; // Maximum verification attempts
const OTP_LENGTH = 6;

// Helper function to generate OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper function to format phone number (ensure E.164 format)
function formatPhoneNumber(phone) {
  // Remove all non-digit characters except +
  let cleaned = phone.replace(/[^\d+]/g, '');
  
  // If it doesn't start with +, add it (assuming default country code)
  if (!cleaned.startsWith('+')) {
    // You can customize this based on your default country
    cleaned = '+1' + cleaned; // Default to +1, change as needed
  }
  
  return cleaned;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Signup endpoint
app.post('/api/signup', async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      investmentAmount,
      country,
      mt5Login,
      mt5Password,
      mt5Server,
      emailVerified,
      phoneVerified,
      partnerId // Optional: partner ID if user was referred by a partner
    } = req.body;

    // Validation
    if (!fullName || !email || !phone || !investmentAmount || !country || !mt5Login || !mt5Password || !mt5Server) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    if (!emailVerified || !phoneVerified) {
      return res.status(400).json({
        success: false,
        error: 'Email and phone must be verified'
      });
    }

    if (parseFloat(investmentAmount) < 100000) {
      return res.status(400).json({
        success: false,
        error: 'Minimum investment amount is $100,000'
      });
    }

    // Check if user already exists
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Validate partner if provided
    if (partnerId) {
      const { data: partner, error: partnerError } = await supabase
        .from('partners')
        .select('id, status')
        .eq('id', partnerId)
        .single();

      if (partnerError || !partner) {
        return res.status(400).json({
          success: false,
          error: 'Invalid partner ID'
        });
      }

      if (partner.status !== 'active') {
        return res.status(400).json({
          success: false,
          error: 'Partner is not active'
        });
      }
    }

    // Check if MT5 login already exists for this server
    const { data: existingMT5, error: mt5CheckError } = await supabase
      .from('mt5_logins')
      .select('id')
      .eq('login', mt5Login)
      .eq('server', mt5Server)
      .single();

    if (existingMT5) {
      return res.status(409).json({
        success: false,
        error: 'MT5 login already exists for this server'
      });
    }

    // Insert user data into Supabase (without MT5 fields)
    const { data: userData, error: userError } = await supabase
      .from('users')
      .insert([
        {
          full_name: fullName,
          email: email,
          phone: phone,
          investment_amount: parseFloat(investmentAmount),
          country: country,
          partner_id: partnerId || null,
          email_verified: emailVerified,
          phone_verified: phoneVerified,
          status: 'pending',
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (userError) {
      console.error('Supabase error creating user:', userError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create user account',
        details: userError.message
      });
    }

    // Insert MT5 login data
    const { data: mt5Data, error: mt5Error } = await supabase
      .from('mt5_logins')
      .insert([
        {
          user_id: userData.id,
          login: mt5Login,
          password: mt5Password, // Note: In production, this should be encrypted
          server: mt5Server,
          is_active: true,
          is_primary: true, // First MT5 login is primary
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (mt5Error) {
      console.error('Supabase error creating MT5 login:', mt5Error);
      // Rollback: delete the user if MT5 insertion fails
      await supabase.from('users').delete().eq('id', userData.id);
      
      return res.status(500).json({
        success: false,
        error: 'Failed to create MT5 login',
        details: mt5Error.message
      });
    }

    res.status(201).json({
      success: true,
      message: 'Registration submitted successfully! Our team will contact you shortly.',
      data: {
        id: userData.id,
        email: userData.email,
        fullName: userData.full_name,
        mt5LoginId: mt5Data.id
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Email OTP endpoint
app.post('/api/send-email-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + OTP_EXPIRY_MINUTES);

    // Invalidate any existing unverified OTPs for this email
    await supabase
      .from('otp_codes')
      .update({ verified: true }) // Mark as verified to invalidate
      .eq('email', email)
      .eq('type', 'email')
      .eq('verified', false);

    // Store OTP in database
    const { error: dbError } = await supabase
      .from('otp_codes')
      .insert([
        {
          email: email,
          otp_code: otp,
          type: 'email',
          expires_at: expiresAt.toISOString(),
          verified: false,
          attempts: 0
        }
      ]);

    if (dbError) {
      console.error('Database error storing OTP:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate verification code'
      });
    }

    // Send email via SendGrid
    if (sendGridApiKey) {
      try {
        const emailBody = `
          <html>
            <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
              <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="color: #333; margin-bottom: 20px;">BAES Solutions - Email Verification</h2>
                <p style="color: #666; font-size: 16px; margin-bottom: 20px;">Your verification code is:</p>
                <div style="background-color: #f0f7ff; padding: 20px; border-radius: 6px; text-align: center; margin: 20px 0;">
                  <h1 style="color: #0066cc; font-size: 36px; letter-spacing: 8px; margin: 0; font-weight: bold;">${otp}</h1>
                </div>
                <p style="color: #666; font-size: 14px; margin-bottom: 10px;">This code will expire in ${OTP_EXPIRY_MINUTES} minutes.</p>
                <p style="color: #999; font-size: 12px; margin-top: 30px;">If you didn't request this code, please ignore this email.</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                <p style="color: #999; font-size: 12px; margin: 0;">BAES Solutions LLC</p>
              </div>
            </body>
          </html>
        `;

        // SendGrid API v3
        const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sendGridApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            personalizations: [{
              to: [{ email: email }]
            }],
            from: { 
              email: sendGridFromEmail,
              name: 'BAES Solutions'
            },
            subject: 'BAES Solutions - Email Verification Code',
            content: [{
              type: 'text/html',
              value: emailBody
            }]
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorDetails;
          try {
            errorDetails = JSON.parse(errorText);
          } catch {
            errorDetails = errorText;
          }
          console.error('SendGrid API error:', {
            status: response.status,
            statusText: response.statusText,
            error: errorDetails
          });
          throw new Error(`SendGrid API error: ${response.status} ${response.statusText}`);
        }

        console.log(`Email OTP sent successfully to ${email}`);
      } catch (emailError) {
        console.error('Error sending email via SendGrid:', emailError);
        // In production, fail the request if email fails
        if (process.env.NODE_ENV === 'production') {
          return res.status(500).json({
            success: false,
            error: 'Failed to send verification email. Please try again later.',
            details: process.env.NODE_ENV === 'development' ? emailError.message : undefined
          });
        } else {
          // In development, log but don't fail (OTP is returned in response)
          console.warn('Email sending failed in development mode, but continuing...');
        }
      }
    } else {
      console.warn('SendGrid API key not configured. Email not sent.');
      if (process.env.NODE_ENV === 'production') {
        return res.status(500).json({
          success: false,
          error: 'Email service not configured'
        });
      }
    }

    res.json({
      success: true,
      message: 'Verification code sent to your email',
      // In development, return OTP for testing
      ...(process.env.NODE_ENV === 'development' && { otp })
    });

  } catch (error) {
    console.error('Error sending email OTP:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send verification code'
    });
  }
});

// Phone OTP endpoint
app.post('/api/send-phone-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    if (!twilioClient || !twilioPhoneNumber) {
      return res.status(500).json({
        success: false,
        error: 'SMS service not configured. Please contact support.'
      });
    }

    // Format phone number to E.164 format
    const formattedPhone = formatPhoneNumber(phone);

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + OTP_EXPIRY_MINUTES);

    // Invalidate any existing unverified OTPs for this phone
    await supabase
      .from('otp_codes')
      .update({ verified: true }) // Mark as verified to invalidate
      .eq('phone', formattedPhone)
      .eq('type', 'phone')
      .eq('verified', false);

    // Store OTP in database
    const { error: dbError } = await supabase
      .from('otp_codes')
      .insert([
        {
          phone: formattedPhone,
          otp_code: otp,
          type: 'phone',
          expires_at: expiresAt.toISOString(),
          verified: false,
          attempts: 0
        }
      ]);

    if (dbError) {
      console.error('Database error storing OTP:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate verification code'
      });
    }

    // Send SMS via Twilio
    try {
      const message = await twilioClient.messages.create({
        body: `Your BAES Solutions verification code is: ${otp}. This code expires in ${OTP_EXPIRY_MINUTES} minutes.`,
        from: twilioPhoneNumber,
        to: formattedPhone
      });

      console.log(`SMS OTP sent to ${formattedPhone}, SID: ${message.sid}`);
    } catch (smsError) {
      console.error('Twilio SMS error:', smsError);
      return res.status(500).json({
        success: false,
        error: 'Failed to send SMS. Please check your phone number and try again.',
        details: smsError.message
      });
    }

    res.json({
      success: true,
      message: 'Verification code sent to your phone',
      // In development, return OTP for testing
      ...(process.env.NODE_ENV === 'development' && { otp })
    });

  } catch (error) {
    console.error('Error sending phone OTP:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send verification code'
    });
  }
});

// Verify OTP endpoint
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { email, phone, otp, type } = req.body;

    if (!otp || !type) {
      return res.status(400).json({
        success: false,
        error: 'OTP and type are required'
      });
    }

    if (type === 'email' && !email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required for email verification'
      });
    }

    if (type === 'phone' && !phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone is required for phone verification'
      });
    }

    // Validate OTP format
    if (otp.length !== OTP_LENGTH || !/^\d+$/.test(otp)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid verification code format'
      });
    }

    // Format phone number if verifying phone
    const formattedPhone = phone ? formatPhoneNumber(phone) : null;

    // Find the OTP record
    let query = supabase
      .from('otp_codes')
      .select('*')
      .eq('type', type)
      .eq('otp_code', otp)
      .eq('verified', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);

    if (type === 'email') {
      query = query.eq('email', email);
    } else {
      query = query.eq('phone', formattedPhone);
    }

    const { data: otpRecords, error: queryError } = await query;

    if (queryError) {
      console.error('Database error:', queryError);
      return res.status(500).json({
        success: false,
        error: 'Failed to verify code'
      });
    }

    if (!otpRecords || otpRecords.length === 0) {
      // Increment attempts for the most recent OTP if it exists
      let attemptQuery = supabase
        .from('otp_codes')
        .select('*')
        .eq('type', type)
        .eq('verified', false)
        .order('created_at', { ascending: false })
        .limit(1);

      if (type === 'email') {
        attemptQuery = attemptQuery.eq('email', email);
      } else {
        attemptQuery = attemptQuery.eq('phone', formattedPhone);
      }

      const { data: recentOtp } = await attemptQuery;

      if (recentOtp && recentOtp.length > 0) {
        const currentAttempts = (recentOtp[0].attempts || 0) + 1;
        await supabase
          .from('otp_codes')
          .update({ attempts: currentAttempts })
          .eq('id', recentOtp[0].id);
      }

      return res.status(400).json({
        success: false,
        error: 'Invalid or expired verification code'
      });
    }

    const otpRecord = otpRecords[0];

    // Check if max attempts exceeded
    if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(400).json({
        success: false,
        error: 'Maximum verification attempts exceeded. Please request a new code.'
      });
    }

    // Mark OTP as verified
    const { error: updateError } = await supabase
      .from('otp_codes')
      .update({ verified: true })
      .eq('id', otpRecord.id);

    if (updateError) {
      console.error('Error updating OTP:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to verify code'
      });
    }

    res.json({
      success: true,
      message: `${type === 'email' ? 'Email' : 'Phone'} verified successfully`,
      verified: true
    });

  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify code'
    });
  }
});

// ============================================
// PARTNER MANAGEMENT ENDPOINTS
// ============================================

// Create a new partner
app.post('/api/partners', async (req, res) => {
  try {
    const { name, email, phone, companyName, commissionRate, notes } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: 'Name and email are required'
      });
    }

    // Check if partner already exists
    const { data: existingPartner } = await supabase
      .from('partners')
      .select('id')
      .eq('email', email)
      .single();

    if (existingPartner) {
      return res.status(409).json({
        success: false,
        error: 'Partner with this email already exists'
      });
    }

    const { data, error } = await supabase
      .from('partners')
      .insert([
        {
          name,
          email,
          phone: phone || null,
          company_name: companyName || null,
          commission_rate: commissionRate || 0.00,
          notes: notes || null,
          status: 'active'
        }
      ])
      .select()
      .single();

    if (error) {
      console.error('Error creating partner:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create partner',
        details: error.message
      });
    }

    res.status(201).json({
      success: true,
      message: 'Partner created successfully',
      data
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Get all partners
app.get('/api/partners', async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabase
      .from('partners')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching partners:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch partners'
      });
    }

    res.json({
      success: true,
      data
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get partner statistics
app.get('/api/partners/:id/statistics', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('partner_statistics')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching partner statistics:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch partner statistics'
      });
    }

    res.json({
      success: true,
      data
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ============================================
// MT5 LOGIN MANAGEMENT ENDPOINTS
// ============================================

// Get all MT5 logins for a user
app.get('/api/users/:userId/mt5-logins', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('mt5_logins')
      .select('id, login, server, is_active, is_primary, created_at, updated_at')
      .eq('user_id', userId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching MT5 logins:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch MT5 logins'
      });
    }

    res.json({
      success: true,
      data
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Add a new MT5 login for a user
app.post('/api/users/:userId/mt5-logins', async (req, res) => {
  try {
    const { userId } = req.params;
    const { login, password, server, isPrimary } = req.body;

    if (!login || !password || !server) {
      return res.status(400).json({
        success: false,
        error: 'Login, password, and server are required'
      });
    }

    // Check if user exists
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if MT5 login already exists
    const { data: existingMT5 } = await supabase
      .from('mt5_logins')
      .select('id')
      .eq('login', login)
      .eq('server', server)
      .single();

    if (existingMT5) {
      return res.status(409).json({
        success: false,
        error: 'MT5 login already exists for this server'
      });
    }

    // If setting as primary, unset other primary logins for this user
    if (isPrimary) {
      await supabase
        .from('mt5_logins')
        .update({ is_primary: false })
        .eq('user_id', userId)
        .eq('is_primary', true);
    }

    const { data, error } = await supabase
      .from('mt5_logins')
      .insert([
        {
          user_id: userId,
          login,
          password, // Note: In production, this should be encrypted
          server,
          is_active: true,
          is_primary: isPrimary || false
        }
      ])
      .select()
      .single();

    if (error) {
      console.error('Error creating MT5 login:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create MT5 login',
        details: error.message
      });
    }

    res.status(201).json({
      success: true,
      message: 'MT5 login added successfully',
      data
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Get user with MT5 logins
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user data
    const { data: user, error: userError } = await supabase
      .from('users')
      .select(`
        *,
        partners (
          id,
          name,
          email,
          company_name
        )
      `)
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get MT5 logins
    const { data: mt5Logins } = await supabase
      .from('mt5_logins')
      .select('id, login, server, is_active, is_primary, created_at')
      .eq('user_id', userId)
      .order('is_primary', { ascending: false });

    res.json({
      success: true,
      data: {
        ...user,
        mt5_logins: mt5Logins || []
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  if (process.env.NODE_ENV === 'production') {
    console.log('Production server started successfully');
  }
});

