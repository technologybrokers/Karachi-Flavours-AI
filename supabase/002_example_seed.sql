-- OPTIONAL EXAMPLE ONLY. Edit these values before running.
-- This file is intentionally not part of the required setup.

update public.business_settings
set business_name = 'Your Food Business',
    pickup_address = 'Enter pickup address in Admin',
    pickup_instructions = 'Pickup only. Please arrive at your confirmed time.',
    payment_instructions = 'Enter your accepted payment method in Admin',
    default_pickup_start = '16:00',
    default_pickup_end = '20:30',
    business_notes = 'Prices are fixed. Orders are subject to live availability.'
where id = 1;

-- Example dish:
-- insert into public.menu_offerings(service_date,item_name,price_cents,portion_size,prepared_qty,pickup_start,pickup_end)
-- values (current_date, 'Example Rice Dish', 1400, '750 ml box', 20, '16:00', '20:30');
